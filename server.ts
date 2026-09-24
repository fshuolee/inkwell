import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import firebaseConfig from './firebase-applet-config.json';
import { verifyFirebaseToken } from './firebaseToken';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const maxRequestBody = process.env.MAX_REQUEST_BODY || '2mb';

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
    // Search from the maximum possible overlap down to 1 character
    const maxPossible = Math.min(prevTail.length, newText.length);
    for (let len = maxPossible; len >= 1; len--) {
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
      for (let len = maxNoWs; len >= 1; len--) {
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
      for (let len = maxTrimmed; len >= 1; len--) {
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
    let chatModel = "gemini-2.5-flash-lite";
    let isClientDisconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        isClientDisconnected = true;
      }
    });

    try {
      if (!req.body || typeof req.body !== 'object' ||
          (req.body.prompt !== undefined && typeof req.body.prompt !== 'string') ||
          (req.body.model !== undefined && typeof req.body.model !== 'string') ||
          (req.body.systemInstruction !== undefined && typeof req.body.systemInstruction !== 'string') ||
          (req.body.history !== undefined && (!Array.isArray(req.body.history) ||
            req.body.history.some((message: unknown) => !message || typeof message !== 'object' ||
              !['user', 'model'].includes((message as { role?: string }).role || '') ||
              typeof (message as { text?: unknown }).text !== 'string')))) {
        res.status(400).json({ error: 'Invalid generation request.' });
        return;
      }
      const { prompt, model, systemInstruction, history, temperature, settings } = req.body;
      
      // Parse user settings with defaults
      const optAutoModelFallback = settings?.autoModelFallback !== false; // default true
      const optAutoContinuationLoop = settings?.autoContinuationLoop !== false; // default true
      const optAutoDeduplicateOverlap = settings?.autoDeduplicateOverlap !== false; // default true
      const optAutoFillDefaultPrompt = settings?.autoFillDefaultPrompt !== false; // default true
      const optAutoRepromptOnAbruptEnd = settings?.autoRepromptOnAbruptEnd !== false; // default true

      chatModel = model || "gemini-2.5-flash-lite";
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
      let totalStreamedText = "";

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
      let fallbackCandidates: string[] = [];
      if (!optAutoModelFallback) {
        // Transparent mode: Strictly and exclusively use the user's chosen model!
        fallbackCandidates = [chatModel];
      } else {
        // High-availability mode: Build fallback chain across separate quota allocations
        const now = Date.now();
        const allCandidateModels = [
          chatModel,
          'gemini-2.5-flash-lite',
          'gemini-3.1-flash-lite',
          'gemini-3.5-flash-lite',
          'gemini-flash-lite-latest',
          'gemini-3.8-flash',
          'gemini-3.7-flash',
          'gemini-3.5-flash',
          'gemini-flash-latest',
          'gemini-2.5-flash'
        ].filter((m, idx, self) => self.indexOf(m) === idx);

        // Prioritize models that are NOT currently in rate-limit cooldown
        fallbackCandidates = allCandidateModels.sort((a, b) => {
          const cooldownA = modelCooldowns.get(a) || 0;
          const cooldownB = modelCooldowns.get(b) || 0;
          const isCooldownA = cooldownA > now;
          const isCooldownB = cooldownB > now;
          if (isCooldownA && !isCooldownB) return 1;
          if (!isCooldownA && isCooldownB) return -1;
          if (isCooldownA && isCooldownB) return cooldownA - cooldownB;
          if (a === chatModel) return -1;
          if (b === chatModel) return 1;
          return 0;
        });
      }

      console.log(`[API] Candidate chain for turn:`, fallbackCandidates);

      while (keepGenerating && attempts < maxAttempts) {
        if (isClientDisconnected) break;
        attempts++;
        let responseStream;
        let lastModelError: any = null;

        for (const candidateModel of fallbackCandidates) {
          if (isClientDisconnected) break;
          try {
            console.log(`[API] Generation attempt #${attempts} using model candidate: ${candidateModel}`);
            responseStream = await ai.models.generateContentStream({
              model: candidateModel,
              contents: currentContents,
              config: {
                systemInstruction: instruction,
                temperature: genTemperature,
              },
            });
            actualModelUsed = candidateModel;
            chatModel = candidateModel;
            break;
          } catch (err: any) {
            lastModelError = err;
            const errMsg = String(err?.message || err);
            console.warn(`[API] Model candidate '${candidateModel}' failed. Trying next candidate. Error:`, errMsg.slice(0, 180));

            // Record cooldown if 429 quota exhaustion or rate limit
            if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota')) {
              let cooldownSeconds = 60;
              const retryMatch = errMsg.match(/retry in ([\d\.]+)s/i) || errMsg.match(/"retryDelay":\s*"(\d+)s"/i);
              if (retryMatch) {
                cooldownSeconds = Math.ceil(parseFloat(retryMatch[1])) + 2;
              }
              modelCooldowns.set(candidateModel, Date.now() + cooldownSeconds * 1000);
              console.log(`[API] Model '${candidateModel}' marked in cooldown for ${cooldownSeconds}s`);
            } else if (errMsg.includes('503') || errMsg.includes('high demand') || errMsg.includes('UNAVAILABLE')) {
              // 503 spike, briefly pause before trying next candidate to relieve gateway pressure
              await new Promise(r => setTimeout(r, 400));
            }
          }
        }

        // Safety net fallback: only execute if autoModelFallback is enabled
        if (!responseStream && !isClientDisconnected && optAutoModelFallback) {
          console.warn("[API] Initial candidates failed. Attempting final safety fallback to gemini-2.5-flash-lite...");
          await new Promise(r => setTimeout(r, 1000));
          try {
            responseStream = await ai.models.generateContentStream({
              model: 'gemini-2.5-flash-lite',
              contents: currentContents,
              config: {
                systemInstruction: instruction,
                temperature: genTemperature,
              },
            });
            actualModelUsed = 'gemini-2.5-flash-lite';
            chatModel = 'gemini-2.5-flash-lite';
          } catch (safetyErr: any) {
            lastModelError = safetyErr;
          }
        }

        if (!responseStream) {
          throw lastModelError || new Error(`Failed to generate content with model '${chatModel}'.`);
        }

        // Stream started successfully, ensure response headers are sent
        ensureHeadersSent();

        let runRawText = "";
        let runCleanText = "";
        let finishReason: string | undefined = undefined;

        // Deduplication & Streaming behavior
        // If optAutoDeduplicateOverlap is false, stream raw text directly without any buffering or overlap stripping
        let overlapResolved = !optAutoDeduplicateOverlap || attempts === 1;
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
      console.error("Gemini API Error:", error);
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

      const isQuota = errorStr.includes('quota') || 
                      errorStr.includes('resource_exhausted') || 
                      errorStr.includes('rate_limit') || 
                      errorStr.includes('429');
      const isUnavailable = errorStr.includes('503') || 
                            errorStr.includes('high demand') || 
                            errorStr.includes('unavailable');

      if (isQuota) {
        let retryMatch = rawError.match(/retry in ([\d\.]+\w?)/i);
        let retryPart = retryMatch ? ` Please retry in ${retryMatch[1]}.` : '';
        friendlyError = `QUOTA_EXCEEDED: Model '${chatModel}' has temporarily exceeded usage quota.${retryPart} Try switching models or retrying shortly.`;
      } else if (isUnavailable) {
        friendlyError = `SERVICE_UNAVAILABLE: Gemini models are currently experiencing temporary high demand spikes. The system will auto-retry momentarily.`;
      }

      const statusCode = isQuota ? 429 : isUnavailable ? 503 : 500;

      if (!res.headersSent) {
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
        res.json({ models: preferredModels });
      } else {
        res.json({ models });
      }
    } catch (error: any) {
      console.error("List Models Error:", error);
      res.json({
        models: [
          { name: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite (Recommended)' },
          { name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
          { name: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite' },
          { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }
        ]
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
