import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import firebaseConfig from './firebase-applet-config.json';
import { verifyFirebaseToken } from './firebaseToken';
import { classifyModelError, openModelStream } from './modelFallback';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const maxRequestBody = process.env.MAX_REQUEST_BODY || '2mb';
  const defaultModel = process.env.DEFAULT_GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const configuredFallbackModels = (process.env.GEMINI_FALLBACK_MODELS || `gemini-3.5-flash-lite,gemini-3.8-flash,${defaultModel},gemini-2.5-flash`)
    .split(',').map(model => model.trim()).filter(Boolean);
  const unavailableCooldownMs = Number(process.env.GEMINI_UNAVAILABLE_COOLDOWN_MS || 30_000);
  const minimumOverlapLength = Number(process.env.MIN_CONTINUATION_OVERLAP || 4);

  // Limit request bodies so large histories cannot exhaust server memory.
  app.use(express.json({ limit: maxRequestBody }));

  // Custom error handler for JSON parsing errors (e.g. PayloadTooLargeError)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({
        error: "The conversation history is too large. Please shorten previous paragraphs or clear old history."
      });
    }
    next(err);
  });

  // Initialize Gemini AI
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Warning: GEMINI_API_KEY environment variable is not set.");
  }
  const ai = new GoogleGenAI({
    apiKey: apiKey || '',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // The browser login alone does not protect these routes: verify each token server-side.
  app.use('/api', async (req, res, next) => {
    const authorization = req.header('authorization');
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) {
      res.status(401).json({ error: 'Please sign in to use the API.' });
      return;
    }
    try {
      await verifyFirebaseToken(token, firebaseConfig.projectId);
      next();
    } catch (error) {
      console.warn('[API] Rejected invalid Firebase ID token:', error);
      res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
  });

  // Track models experiencing rate limits (429) or high demand (503) with expiration timestamps
  const modelCooldowns = new Map<string, number>();

  /**
   * Automatically detects and removes overlapping text between the suffix of previous output
   * and the prefix of newly generated continuation output.
   * 
   * When LLMs are requested to continue from where they stopped, they frequently repeat the last
   * few words, phrases, or full sentences (e.g. "...姊姊的呼吸變得更加紊" -> "姊姊的呼吸變得更加紊亂").
   * This helper finds the longest overlapping prefix-suffix boundary and cleanly strips it out.
   */
  function removeContinuationOverlap(prevText: string, newText: string): { cleanedText: string; overlapFound: string } {
    if (!prevText || !newText) {
      return { cleanedText: newText, overlapFound: '' };
    }

    // Inspect the tail of prevText (up to 2000 characters to cover long clauses/sentences)
    const maxSearchLen = Math.min(2000, prevText.length);
    const prevTail = prevText.slice(-maxSearchLen);

    // 1. Direct Longest Suffix-Prefix Exact Match
    // Search from the maximum possible overlap down to the configured minimum.
    const maxPossible = Math.min(prevTail.length, newText.length);
    for (let len = maxPossible; len >= minimumOverlapLength; len--) {
      const prevSuffix = prevTail.slice(-len);
      const newPrefix = newText.slice(0, len);
      if (prevSuffix === newPrefix) {
        return {
          cleanedText: newText.slice(len),
          overlapFound: newPrefix
        };
      }
    }

    // 2. Overlap with leading whitespace in newText
    // Handles scenarios where the new output starts with \n or spaces before repeating the previous text
    const leadingWsMatch = newText.match(/^[\s\r\n]+/);
    if (leadingWsMatch) {
      const wsPrefix = leadingWsMatch[0];
      const newTextNoWs = newText.slice(wsPrefix.length);
      const maxNoWs = Math.min(prevTail.length, newTextNoWs.length);
      for (let len = maxNoWs; len >= minimumOverlapLength; len--) {
        const prevSuffix = prevTail.slice(-len);
        const newPrefix = newTextNoWs.slice(0, len);
        if (prevSuffix === newPrefix) {
          return {
            cleanedText: newTextNoWs.slice(len),
            overlapFound: wsPrefix + newPrefix
          };
        }
      }
    }

    // 3. Overlap with trailing whitespace in prevTail
    // Handles scenarios where the previous stream ended with trailing whitespace omitted in the new generation
    const trimmedPrevTail = prevTail.trimEnd();
    if (trimmedPrevTail.length > 0 && trimmedPrevTail.length < prevTail.length) {
      const maxTrimmed = Math.min(trimmedPrevTail.length, newText.length);
      for (let len = maxTrimmed; len >= minimumOverlapLength; len--) {
        const prevSuffix = trimmedPrevTail.slice(-len);
        const newPrefix = newText.slice(0, len);
        if (prevSuffix === newPrefix) {
          return {
            cleanedText: newText.slice(len),
            overlapFound: newPrefix
          };
        }
      }
    }

    // 4. Sentence/Clause repetition with minor punctuation variation
    // Checks if the last sentence/clause in prevTail matches the start of newText
    const clauses = prevTail.split(/([。！？\n.!?]+)/).filter(c => c.trim().length >= 4);
    if (clauses.length > 0) {
      const lastClause = clauses[clauses.length - 1].trim();
      const cleanNew = newText.trimStart();
      if (cleanNew.startsWith(lastClause)) {
        const idx = newText.indexOf(lastClause);
        const afterMatch = newText.slice(idx + lastClause.length);
        const cleaned = afterMatch.replace(/^[\s,，.。!！?？]+/, '');
        return {
          cleanedText: cleaned,
          overlapFound: newText.slice(0, idx + lastClause.length)
        };
      }
    }

    return { cleanedText: newText, overlapFound: '' };
  }

  // API Route for Gemini Generation (with streaming support)
  app.post('/api/generate', async (req, res) => {
    let chatModel = defaultModel;
    let isClientDisconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        isClientDisconnected = true;
      }
    });

    try {
      if (!req.body || typeof req.body !== 'object' ||
          (req.body.prompt !== undefined && typeof req.body.prompt !== 'string') ||
          (req.body.model !== undefined && (typeof req.body.model !== 'string' ||
            req.body.model.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(req.body.model))) ||
          (req.body.systemInstruction !== undefined && typeof req.body.systemInstruction !== 'string') ||
          (req.body.previousText !== undefined && typeof req.body.previousText !== 'string') ||
          (req.body.history !== undefined && (!Array.isArray(req.body.history) ||
            req.body.history.some((message: unknown) => !message || typeof message !== 'object' ||
              !['user', 'model'].includes((message as { role?: string }).role || '') ||
              typeof (message as { text?: unknown }).text !== 'string')))) {
        res.status(400).json({ error: 'Invalid generation request.' });
        return;
      }
      const { prompt, model, systemInstruction, history, temperature, settings, previousText } = req.body;
      
      // Parse user settings with defaults
      const optAutoModelFallback = settings?.autoModelFallback !== false; // default true
      const optAutoContinuationLoop = settings?.autoContinuationLoop !== false; // default true
      const optAutoDeduplicateOverlap = settings?.autoDeduplicateOverlap !== false; // default true
      const optAutoFillDefaultPrompt = settings?.autoFillDefaultPrompt !== false; // default true
      const optAutoRepromptOnAbruptEnd = settings?.autoRepromptOnAbruptEnd !== false; // default true

      chatModel = model || defaultModel;
      // Strictly use the systemInstruction sent by the client at generation time without any extra injected text
      const rawInstruction = typeof systemInstruction === 'string' ? systemInstruction.trim() : '';
      const instruction = rawInstruction || "You are a creative story writer.";

      console.log(`[API] /api/generate - Requested Model: ${chatModel}, Settings: fallback=${optAutoModelFallback}, loop=${optAutoContinuationLoop}, dedup=${optAutoDeduplicateOverlap}, autoFill=${optAutoFillDefaultPrompt}, reprompt=${optAutoRepromptOnAbruptEnd}`);

      // Default to 0.7 for creative diversity; allows retrying the same prompt to produce fresh variations
      const genTemperature = typeof temperature === 'number' ? temperature : 0.7;

      // Enforce strictly alternating roles (user <-> model) as required by Gemini API
      const contents: any[] = [];
      if (history && history.length > 0) {
        let lastRole: string | null = null;
        history.forEach((msg: any) => {
          const role = msg.role === 'model' ? 'model' : 'user';
          const text = msg.text || '';
          if (!text.trim()) return; // Skip empty messages
          
          if (lastRole === role) {
            // Append to the last message if the roles are identical in sequence
            if (contents.length > 0) {
              contents[contents.length - 1].parts[0].text += "\n\n" + text;
            }
          } else {
            contents.push({ role, parts: [{ text }] });
            lastRole = role;
          }
        });
      }

      const trimmedPrompt = (prompt || '').trim();

      // Merge user prompt if the last history message was also 'user'
      if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        if (trimmedPrompt) {
          contents[contents.length - 1].parts[0].text += "\n\n" + trimmedPrompt;
        }
      } else {
        if (trimmedPrompt) {
          contents.push({ role: 'user', parts: [{ text: trimmedPrompt }] });
        } else if (optAutoFillDefaultPrompt) {
          contents.push({ role: 'user', parts: [{ text: "Please continue the story seamlessly." }] });
        } else {
          // If autoFillDefaultPrompt is disabled, do not inject any implicit prompt
          // If contents is completely empty, Gemini requires at least one user part
          if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: " " }] });
          }
        }
      }

      const currentContents = [...contents];
      let attempts = 0;
      const maxAttempts = optAutoContinuationLoop ? 4 : 1;
      let keepGenerating = true;
      let actualModelUsed = chatModel;

      // Track the total clean text streamed to the client across all attempts
      let totalStreamedText = previousText || "";

      const ensureHeadersSent = () => {
        if (!res.headersSent) {
          // Standard streaming headers compatible with HTTP/1.1 and HTTP/2
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('X-Model-Used', actualModelUsed);
          res.flushHeaders();
        }
      };

      // Build model candidate list based on user's autoModelFallback setting
      const candidateModels = [...new Set(optAutoModelFallback
        ? [chatModel, ...configuredFallbackModels]
        : [chatModel])];
      const now = Date.now();
      const fallbackCandidates = candidateModels.filter(candidate => (modelCooldowns.get(candidate) || 0) <= now);
      if (fallbackCandidates.length === 0) {
        const nextAvailable = Math.min(...candidateModels.map(candidate => modelCooldowns.get(candidate) || now));
        res.setHeader('Retry-After', Math.max(1, Math.ceil((nextAvailable - now) / 1_000)));
        res.status(503).json({ error: 'SERVICE_UNAVAILABLE: Models are temporarily busy. Please retry shortly.' });
        return;
      }

      console.log(`[API] Candidate chain for turn:`, fallbackCandidates);

      while (keepGenerating && attempts < maxAttempts) {
        if (isClientDisconnected) break;
        attempts++;
        const availableCandidates = fallbackCandidates.filter(candidate => (modelCooldowns.get(candidate) || 0) <= Date.now());
        if (availableCandidates.length === 0) {
          const nextAvailable = Math.min(...fallbackCandidates.map(candidate => modelCooldowns.get(candidate) || Date.now()));
          throw Object.assign(new Error('All model candidates are temporarily unavailable'), {
            status: 503,
            retryAfterMs: Math.max(1_000, nextAvailable - Date.now()),
          });
        }
        const { model: selectedModel, stream: responseStream } = await openModelStream(
          availableCandidates,
          candidateModel => ai.models.generateContentStream({
            model: candidateModel,
            contents: currentContents,
            config: { systemInstruction: instruction, temperature: genTemperature },
          }),
          error => optAutoModelFallback && [404, 429, 503].includes(classifyModelError(error).status || 0),
          (candidateModel, error) => {
            const { status, retryAfterMs } = classifyModelError(error);
            console.warn(`[API] Model ${candidateModel} failed before streaming (status ${status ?? 'unknown'}).`);
            if (status === 429 || status === 503) {
              modelCooldowns.set(candidateModel, Date.now() + (retryAfterMs || unavailableCooldownMs));
            }
          },
          chunk => {
            try {
              if (chunk.text) return true;
            } catch { /* Some non-text chunks have no text accessor. */ }
            return Boolean(chunk.candidates?.[0]?.finishReason || chunk.candidates?.[0]?.content?.parts?.[0]?.text);
          },
        );
        actualModelUsed = selectedModel;
        chatModel = selectedModel;

        // Stream started successfully, ensure response headers are sent
        ensureHeadersSent();

        let runRawText = "";
        let runCleanText = "";
        let finishReason: string | undefined = undefined;

        // Deduplication & Streaming behavior
        // If optAutoDeduplicateOverlap is false, stream raw text directly without any buffering or overlap stripping
        let overlapResolved = !optAutoDeduplicateOverlap || (attempts === 1 && !previousText);
        const maxOverlapCheckWindow = Math.min(400, totalStreamedText.length) + 40;

        for await (const chunk of responseStream) {
          if (isClientDisconnected) {
            keepGenerating = false;
            break;
          }
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
            finishReason = candidate.finishReason;
          }
          let textPart = "";
          try {
            if (chunk.text) {
              textPart = chunk.text;
            } else if (candidate?.content?.parts?.[0]?.text) {
              textPart = candidate.content.parts[0].text;
            }
          } catch (e) {
            if (candidate?.content?.parts?.[0]?.text) {
              textPart = candidate.content.parts[0].text;
            }
          }
          if (textPart) {
            runRawText += textPart;

            if (overlapResolved || !optAutoDeduplicateOverlap) {
              // Direct streaming with zero delay or alteration
              runCleanText += textPart;
              totalStreamedText += textPart;
              res.write(textPart);
              if (typeof (res as any).flush === 'function') {
                (res as any).flush();
              }
            } else {
              // Check if buffer reached threshold to deduplicate and release stream
              if (runRawText.length >= maxOverlapCheckWindow) {
                const { cleanedText, overlapFound } = removeContinuationOverlap(totalStreamedText, runRawText);
                if (overlapFound) {
                  console.log(`[API] Auto-deduplicated overlap in attempt #${attempts} (${overlapFound.length} chars): "${overlapFound}"`);
                }
                overlapResolved = true;
                if (cleanedText) {
                  runCleanText += cleanedText;
                  totalStreamedText += cleanedText;
                  res.write(cleanedText);
                  if (typeof (res as any).flush === 'function') {
                    (res as any).flush();
                  }
                }
              }
            }
          }
        }

        // If the stream ended before reaching the buffer threshold, resolve overlap now (if enabled)
        if (!overlapResolved && optAutoDeduplicateOverlap) {
          const { cleanedText, overlapFound } = removeContinuationOverlap(totalStreamedText, runRawText);
          if (overlapFound) {
            console.log(`[API] Auto-deduplicated overlap at end of attempt #${attempts} (${overlapFound.length} chars): "${overlapFound}"`);
          }
          overlapResolved = true;
          if (cleanedText) {
            runCleanText += cleanedText;
            totalStreamedText += cleanedText;
            res.write(cleanedText);
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          }
        }

        // Check if we need to auto-continue (only if optAutoContinuationLoop is true)
        if (!optAutoContinuationLoop) {
          // Transparent mode: single round only, do not loop
          keepGenerating = false;
        } else if (!optAutoRepromptOnAbruptEnd) {
          // Transparent prompt mode: do not inject synthetic continue prompts on abrupt stop
          keepGenerating = false;
        } else {
          const trimmedRunCleanText = runCleanText.trimEnd();
          let isAbruptEnd = false;
          if (trimmedRunCleanText) {
            const lastChar = trimmedRunCleanText[trimmedRunCleanText.length - 1];
            const validEnders = ['.', '?', '!', '"', "'", '。', '？', '！', '」', '》', '”', '’', '】', '』', '…', '~', '*', '>', ')', ']', '—', '-'];
            if (!validEnders.includes(lastChar)) {
              isAbruptEnd = true;
            }
          }

          if (finishReason && finishReason !== 'STOP') {
            console.warn(`[API] Stream attempt #${attempts} ended prematurely with finishReason: ${finishReason}`);

            if (runRawText.trim()) {
              currentContents.push({ role: 'model', parts: [{ text: runRawText }] });
              
              if (finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH') {
                currentContents.push({
                  role: 'user',
                  parts: [{ text: "Please continue seamlessly from where you left off." }]
                });
              } else if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'SPII' || finishReason === 'BLOCKLIST') {
                currentContents.push({
                  role: 'user',
                  parts: [{ text: "Continue the story smoothly while staying within safety parameters. Transition the scene safely so the story continues without interruption." }]
                });
              } else {
                currentContents.push({
                  role: 'user',
                  parts: [{ text: "Please continue the story smoothly from where you paused." }]
                });
              }
              keepGenerating = true;
            } else {
              // No new characters were yielded (immediate block/safety trigger)
              if (currentContents.length > 0 && currentContents[currentContents.length - 1].role === 'user') {
                currentContents[currentContents.length - 1].parts[0].text += "\n\n(Auto-Continuation Guidance: Please ensure the story proceeds in an engaging, safe, and appropriate creative style.)";
                keepGenerating = true;
              } else {
                keepGenerating = false;
              }
            }
          } else if (isAbruptEnd && attempts < maxAttempts) {
            console.warn(`[API] Stream stopped but text ended abruptly. Auto-continuing...`);
            currentContents.push({ role: 'model', parts: [{ text: runRawText }] });
            currentContents.push({
              role: 'user',
              parts: [{ text: "Please continue seamlessly from where you left off." }]
            });
            keepGenerating = true;
          } else {
            // Completed normally with STOP or no special finishReason and looks complete
            keepGenerating = false;
          }
        }
      }

      res.end();
    } catch (error: any) {
      const { status, retryAfterMs } = classifyModelError(error);
      console.error(`[API] Gemini generation failed for ${chatModel} (status ${status ?? 'unknown'}).`);
      let rawError = String(error?.message || error || "Failed to generate content");
      
      // Robust recursive extraction of nested JSON error payloads
      const extractDeepErrorMessage = (msg: string): string => {
        let current = msg.replace(/^[a-zA-Z0-9_]+Error:\s*/, '');
        for (let i = 0; i < 4; i++) {
          const match = current.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const parsed = JSON.parse(match[0]);
              if (parsed?.error?.message && typeof parsed.error.message === 'string') {
                current = parsed.error.message;
                continue;
              } else if (parsed?.message && typeof parsed.message === 'string') {
                current = parsed.message;
                continue;
              }
            } catch (_) {
              break;
            }
          }
          break;
        }
        return current.trim();
      };

      let friendlyError = extractDeepErrorMessage(rawError);
      const errorStr = (rawError + " " + friendlyError).toLowerCase();

      const isQuota = status === 429 || errorStr.includes('quota') ||
                      errorStr.includes('resource_exhausted') ||
                      errorStr.includes('rate_limit') ||
                      errorStr.includes('429');
      const isUnavailable = status === 503 || errorStr.includes('503') ||
                            errorStr.includes('high demand') ||
                            errorStr.includes('unavailable');

      if (isQuota) {
        let retryMatch = rawError.match(/retry in ([\d\.]+\w?)/i);
        let retryPart = retryMatch ? ` Please retry in ${retryMatch[1]}.` : '';
        friendlyError = `QUOTA_EXCEEDED: Model '${chatModel}' has temporarily exceeded usage quota.${retryPart} Try switching models or retrying shortly.`;
      } else if (isUnavailable) {
        friendlyError = 'SERVICE_UNAVAILABLE: The selected models are temporarily busy. Please retry shortly or choose another model.';
      } else if (status === 400 || status === 404) {
        friendlyError = 'INVALID_MODEL_OR_REQUEST: The selected model could not process this request. Please choose another model or edit the prompt.';
      } else if (status === 401 || status === 403) {
        friendlyError = 'AI_SERVICE_AUTH_ERROR: The server could not access Gemini. Please check its API credentials.';
      } else {
        friendlyError = 'Generation failed unexpectedly. Please retry shortly.';
      }

      const statusCode = isQuota ? 429 : isUnavailable ? 503
        : status === 400 || status === 404 ? 400
        : status === 401 || status === 403 ? 403 : 500;

      if (!res.headersSent) {
        if (isQuota || isUnavailable) {
          res.setHeader('Retry-After', Math.ceil((retryAfterMs || unavailableCooldownMs) / 1_000));
        }
        res.status(statusCode).json({ error: friendlyError });
      } else {
        res.write(`\n\n[ERROR: ${friendlyError}]`);
        res.end();
      }
    }
  });

  app.get('/api/models', async (req, res) => {
    try {
      const response = await ai.models.list();
      const allListed = new Map<string, string>();
      for await (const m of response) {
        if (m.name.includes("gemini")) {
          const nameStr = m.name.split('/').pop();
          if (nameStr) {
            allListed.set(nameStr, m.displayName || nameStr);
          }
        }
      }

      // Curate list of text-capable story generation models in order of stability and quota
      const preferredModels = [
        { name: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite (Recommended - Fast & High Quota)' },
        { name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
        { name: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite' },
        { name: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash' },
        { name: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
        { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        { name: 'gemini-flash-latest', displayName: 'Gemini Flash Latest' },
        { name: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' }
      ];

      const models = preferredModels.filter(pm => allListed.has(pm.name));
      if (models.length === 0) {
        res.json({ models: configuredFallbackModels.map(name => ({ name, displayName: name })) });
      } else {
        res.json({ models });
      }
    } catch (error: any) {
      console.error("List Models Error:", error);
      res.json({
        models: configuredFallbackModels.map(name => ({ name, displayName: name }))
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
