/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useRef, useEffect, useCallback, ReactNode } from 'react';
import { updateStory } from '../firebase/db';
import { loadStoredSettings } from '../types/settings';
import { authenticatedFetch } from '../firebase/api';
import { preparePartialRetry } from './generationRetry';
import { assertGenerationResponse } from './generationResponse';

const BUSY_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 60;

export interface Message {
  role: 'user' | 'model';
  text: string;
}

export interface ReconnectState {
  isReconnecting: boolean;
  attempt: number;
  maxAttempts: number;
  countdown: number;
  reason?: string;
}

export interface GenerationSession {
  storyId: string;
  isGenerating: boolean;
  messages: Message[];
  accumulatedText: string;
  model: string;
  promptText: string;
  systemInstruction?: string;
  presetId?: string;
  error: string | null;
  reconnectState: ReconnectState;
  isUserAborted: boolean;
  lastUpdated: number;
}

export interface StartGenerationParams {
  storyId: string;
  prompt: string;
  model: string;
  systemInstruction: string;
  presetId?: string;
  baseHistory: Message[];
  isRetry?: boolean;
  initialAccumulated?: string;
  currentAttempt?: number;
  onStorySaved?: (storyId: string) => void;
}

export interface StoryGenerationContextType {
  generatingStoryIds: Set<string>;
  isStoryGenerating: (storyId: string) => boolean;
  getGenerationSession: (storyId: string) => GenerationSession | undefined;
  startGeneration: (params: StartGenerationParams) => Promise<void>;
  stopGeneration: (storyId: string) => Promise<void>;
  cancelAutoReconnect: (storyId: string) => void;
  triggerImmediateReconnect: (storyId: string) => void;
  clearStoryError: (storyId: string) => void;
  subscribeToStory: (storyId: string, listener: (session: GenerationSession) => void) => () => void;
}

const StoryGenerationContext = createContext<StoryGenerationContextType | null>(null);

export function StoryGenerationProvider({ children }: { children: ReactNode }) {
  // Map of storyId -> GenerationSession
  const sessionsRef = useRef<Map<string, GenerationSession>>(new Map());
  // Set of actively generating story IDs for fast reactive checking
  const [generatingStoryIds, setGeneratingStoryIds] = useState<Set<string>>(new Set());

  // Listeners for UI components viewing specific stories: storyId -> Set of callbacks
  const subscribersRef = useRef<Map<string, Set<(session: GenerationSession) => void>>>(new Map());

  // Per-story AbortControllers
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Per-story auto-reconnect timers and countdowns
  const reconnectTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const reconnectIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const pendingReconnectsRef = useRef<Map<string, () => void>>(new Map());

  const notifySubscribers = useCallback((storyId: string, session: GenerationSession) => {
    const listeners = subscribersRef.current.get(storyId);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback({ ...session, messages: [...session.messages] });
        } catch (e) {
          console.error(`Error notifying subscriber for story ${storyId}:`, e);
        }
      });
    }
  }, []);

  const updateGeneratingStoryIds = useCallback(() => {
    const active = new Set<string>();
    sessionsRef.current.forEach((session, id) => {
      if (session.isGenerating || session.reconnectState.isReconnecting) {
        active.add(id);
      }
    });
    setGeneratingStoryIds(active);
  }, []);

  const clearReconnectTimers = useCallback((storyId: string) => {
    const timer = reconnectTimersRef.current.get(storyId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimersRef.current.delete(storyId);
    }
    const interval = reconnectIntervalsRef.current.get(storyId);
    if (interval) {
      clearInterval(interval);
      reconnectIntervalsRef.current.delete(storyId);
    }
    pendingReconnectsRef.current.delete(storyId);
  }, []);

  // Listen for network reconnection to immediately trigger pending retries across all stories
  useEffect(() => {
    const handleOnline = () => {
      pendingReconnectsRef.current.forEach((action, storyId) => {
        clearReconnectTimers(storyId);
        action();
      });
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [clearReconnectTimers]);

  const isStoryGenerating = useCallback((storyId: string): boolean => {
    const session = sessionsRef.current.get(storyId);
    return !!session && (session.isGenerating || session.reconnectState.isReconnecting);
  }, []);

  const getGenerationSession = useCallback((storyId: string): GenerationSession | undefined => {
    return sessionsRef.current.get(storyId);
  }, []);

  const clearStoryError = useCallback((storyId: string) => {
    const session = sessionsRef.current.get(storyId);
    if (session) {
      session.error = null;
      notifySubscribers(storyId, session);
    }
  }, [notifySubscribers]);

  const cancelAutoReconnect = useCallback((storyId: string) => {
    clearReconnectTimers(storyId);
    const session = sessionsRef.current.get(storyId);
    if (session) {
      session.isGenerating = false;
      session.reconnectState = { isReconnecting: false, attempt: 0, maxAttempts: 3, countdown: 0 };
      updateGeneratingStoryIds();
      notifySubscribers(storyId, session);
    }
  }, [clearReconnectTimers, updateGeneratingStoryIds, notifySubscribers]);

  const triggerImmediateReconnect = useCallback((storyId: string) => {
    const action = pendingReconnectsRef.current.get(storyId);
    if (action) {
      clearReconnectTimers(storyId);
      action();
    }
  }, [clearReconnectTimers]);

  const stopGeneration = useCallback(async (storyId: string) => {
    clearReconnectTimers(storyId);
    const session = sessionsRef.current.get(storyId);
    if (session) {
      session.isUserAborted = true;
    }
    const controller = abortControllersRef.current.get(storyId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(storyId);
    }
    if (session) {
      session.isGenerating = false;
      session.reconnectState = { isReconnecting: false, attempt: 0, maxAttempts: 3, countdown: 0 };
      updateGeneratingStoryIds();
      notifySubscribers(storyId, session);
    }
  }, [clearReconnectTimers, updateGeneratingStoryIds, notifySubscribers]);

  const subscribeToStory = useCallback((storyId: string, listener: (session: GenerationSession) => void) => {
    if (!subscribersRef.current.has(storyId)) {
      subscribersRef.current.set(storyId, new Set());
    }
    const listeners = subscribersRef.current.get(storyId)!;
    listeners.add(listener);

    // If an existing session is available, send initial notification immediately
    const existing = sessionsRef.current.get(storyId);
    if (existing) {
      listener({ ...existing, messages: [...existing.messages] });
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        subscribersRef.current.delete(storyId);
      }
    };
  }, []);

  const startGeneration = useCallback(async (params: StartGenerationParams): Promise<void> => {
    const {
      storyId,
      prompt,
      model,
      systemInstruction,
      presetId,
      baseHistory,
      isRetry = false,
      initialAccumulated = '',
      currentAttempt = 0,
      onStorySaved
    } = params;

    clearReconnectTimers(storyId);

    let promptText = prompt;
    let apiPrompt = prompt;
    let historyForApi: Message[] = [...baseHistory];
    let newDisplayHistory: Message[] = [...baseHistory];

    if (initialAccumulated) {
      const retry = preparePartialRetry(baseHistory, prompt, initialAccumulated);
      newDisplayHistory = retry.displayHistory;
      historyForApi = retry.apiHistory;
      apiPrompt = retry.apiPrompt;
    } else if (isRetry) {
      // Find the last user message in baseHistory
      let lastUserIndex = -1;
      for (let i = baseHistory.length - 1; i >= 0; i--) {
        if (baseHistory[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }
      if (lastUserIndex !== -1) {
        promptText = baseHistory[lastUserIndex].text;
        apiPrompt = promptText;
        historyForApi = baseHistory.slice(0, lastUserIndex);
        newDisplayHistory = baseHistory.slice(0, lastUserIndex + 1);
      } else if (prompt && prompt.trim()) {
        promptText = prompt.trim();
        apiPrompt = promptText;
        newDisplayHistory = [...baseHistory, { role: 'user', text: promptText }];
        historyForApi = [...baseHistory];
      } else {
        return;
      }
    } else {
      promptText = prompt.trim();
      apiPrompt = promptText;
      const userMsg: Message = { role: 'user', text: promptText };
      newDisplayHistory = [...baseHistory, userMsg];
      historyForApi = [...baseHistory];
    }

    // Prepare display messages with model slot for streaming
    let displayMessagesWithModel: Message[];
    if (initialAccumulated) {
      displayMessagesWithModel = [...newDisplayHistory];
      const last = displayMessagesWithModel[displayMessagesWithModel.length - 1];
      if (!last || last.role !== 'model') {
        displayMessagesWithModel.push({ role: 'model', text: initialAccumulated });
      }
    } else {
      displayMessagesWithModel = [...newDisplayHistory, { role: 'model', text: '' }];
    }

    const controller = new AbortController();
    abortControllersRef.current.set(storyId, controller);

    let accumulatedText = initialAccumulated || '';

    const session: GenerationSession = {
      storyId,
      isGenerating: true,
      messages: displayMessagesWithModel,
      accumulatedText,
      model,
      promptText,
      systemInstruction,
      presetId,
      error: null,
      reconnectState: { isReconnecting: false, attempt: 0, maxAttempts: 3, countdown: 0 },
      isUserAborted: false,
      lastUpdated: Date.now()
    };

    sessionsRef.current.set(storyId, session);
    updateGeneratingStoryIds();
    notifySubscribers(storyId, session);

    // CRITICAL: Immediately persist the user message to the database
    // so that even if the API throws an immediate error (429, 503, network drop),
    // the user's input/dialogue is NEVER lost!
    try {
      await updateStory(storyId, {
        history: initialAccumulated
          ? [...newDisplayHistory, { role: 'model', text: initialAccumulated }]
          : newDisplayHistory,
        model,
        systemInstruction: systemInstruction || undefined,
        presetId: presetId || undefined
      });
      onStorySaved?.(storyId);
    } catch (saveErr) {
      console.warn(`[Generation] Pre-save of user prompt for story ${storyId}:`, saveErr);
    }

    let effectiveModel = model;
    try {
      const activeSettings = loadStoredSettings();
      const res = await authenticatedFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: apiPrompt,
          model,
          systemInstruction,
          history: historyForApi,
          previousText: initialAccumulated,
          settings: activeSettings
        }),
        signal: controller.signal
      });

      // A hosting gateway may return a 200/503 HTML warmup page while the API restarts.
      assertGenerationResponse(res);

      if (!res.ok) {
        let errorData: any = {};
        try {
          errorData = await res.json();
        } catch (_) {}
        const requestError = new Error(errorData.error || `HTTP ${res.status}: Failed to generate content`);
        Object.assign(requestError, {
          status: res.status,
          retryAfterSeconds: Number(res.headers.get('Retry-After')) || null,
        });
        throw requestError;
      }

      effectiveModel = res.headers.get('X-Model-Used') || model;
      session.model = effectiveModel;

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable.');
      }

      const decoder = new TextDecoder('utf-8');

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            const finalChunk = decoder.decode();
            if (finalChunk) {
              accumulatedText += finalChunk;
            }
            break;
          }

          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            accumulatedText += chunk;

            // Check for mid-stream error tokens
            if (accumulatedText.includes('\n\n[ERROR:')) {
              const errorMatch = accumulatedText.match(/\n\n\[ERROR: ([\s\S]*?)\]/);
              const cleanText = accumulatedText.replace(/\n\n\[ERROR: [\s\S]*?\]/, '');
              accumulatedText = cleanText;

              const updatedMsgs = [...session.messages];
              if (updatedMsgs.length > 0) {
                updatedMsgs[updatedMsgs.length - 1] = { role: 'model', text: cleanText };
              }
              session.messages = updatedMsgs;
              session.accumulatedText = cleanText;
              notifySubscribers(storyId, session);

              let errDetail = errorMatch ? errorMatch[1] : 'Generation error occurred during streaming.';
              try {
                const parsed = JSON.parse(errDetail);
                if (parsed?.error?.message) {
                  errDetail = parsed.error.message;
                }
              } catch (_) {}
              throw new Error(errDetail);
            }

            const updatedMsgs = [...session.messages];
            if (updatedMsgs.length > 0) {
              const last = updatedMsgs[updatedMsgs.length - 1];
              if (last.role === 'model' && last.text !== accumulatedText) {
                updatedMsgs[updatedMsgs.length - 1] = { role: 'model', text: accumulatedText };
                session.messages = updatedMsgs;
                session.accumulatedText = accumulatedText;
                session.lastUpdated = Date.now();
                notifySubscribers(storyId, session);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Generation succeeded!
      const finalHistory: Message[] = [...newDisplayHistory, { role: 'model', text: accumulatedText }];
      session.isGenerating = false;
      session.messages = finalHistory;
      session.accumulatedText = accumulatedText;
      session.reconnectState = { isReconnecting: false, attempt: 0, maxAttempts: 3, countdown: 0 };
      session.lastUpdated = Date.now();

      abortControllersRef.current.delete(storyId);
      updateGeneratingStoryIds();
      notifySubscribers(storyId, session);

      // Persist generated story history, model, and active system instruction/preset to database
      await updateStory(storyId, {
        history: finalHistory,
        model: effectiveModel,
        systemInstruction: systemInstruction || undefined,
        presetId: presetId || undefined
      });
      onStorySaved?.(storyId);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('inkwell:story-saved', { detail: { storyId } }));
      }

    } catch (err: any) {
      if (err.name === 'AbortError' || session.isUserAborted) {
        console.log(`[Generation] Story ${storyId} stopped by user.`);
        session.isGenerating = false;
        session.reconnectState = { isReconnecting: false, attempt: 0, maxAttempts: 3, countdown: 0 };
        abortControllersRef.current.delete(storyId);
        updateGeneratingStoryIds();

        // Preserve and persist any partial generation so work is never lost
        if (accumulatedText && accumulatedText.trim()) {
          const partialHistory: Message[] = [...newDisplayHistory, { role: 'model', text: accumulatedText }];
          session.messages = partialHistory;
          await updateStory(storyId, {
            history: partialHistory,
            model: effectiveModel,
            systemInstruction: systemInstruction || undefined,
            presetId: presetId || undefined
          });
          onStorySaved?.(storyId);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('inkwell:story-saved', { detail: { storyId } }));
          }
        } else {
          session.messages = [...newDisplayHistory];
          await updateStory(storyId, {
            history: session.messages,
            model: effectiveModel,
            systemInstruction: systemInstruction || undefined,
            presetId: presetId || undefined
          });
          onStorySaved?.(storyId);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('inkwell:story-saved', { detail: { storyId } }));
          }
        }
        notifySubscribers(storyId, session);
      } else {
        const rawErrMsg = String(err?.message || err || '');
        let displayError = rawErrMsg.replace(/^[a-zA-Z0-9_]+Error:\s*/, '');

        // Extract nested JSON error if present
        for (let i = 0; i < 4; i++) {
          const match = displayError.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const parsed = JSON.parse(match[0]);
              if (parsed?.error?.message && typeof parsed.error.message === 'string') {
                displayError = parsed.error.message;
                continue;
              } else if (parsed?.message && typeof parsed.message === 'string') {
                displayError = parsed.message;
                continue;
              }
            } catch (_) {
              break;
            }
          }
          break;
        }

        const lowerErr = (displayError + ' ' + rawErrMsg).toLowerCase();
        const httpStatus = Number(err?.status);
        if (err?.code === 'SERVER_STARTING') {
          console.warn(`[Generation] Application server is still starting for story ${storyId}.`);
        } else if (httpStatus === 503 || lowerErr.includes('high demand')) {
          console.warn(`[Generation] Model temporarily unavailable for story ${storyId}.`);
        } else {
          console.error(`[Generation] Error on story ${storyId}:`, err);
        }
        if (err?.code === 'SERVER_STARTING') {
          displayError = 'SERVER_STARTING: 應用伺服器尚未就緒，正在稍候重試。';
        } else if (displayError === 'Load failed' || displayError === 'Failed to fetch' || lowerErr.includes('networkerror') || lowerErr.includes('failed to fetch')) {
          displayError = '連線中斷或伺服器回應逾時 (Connection interrupted or server timed out)';
        } else if (lowerErr.includes('503') || lowerErr.includes('high demand') || lowerErr.includes('unavailable') || lowerErr.includes('service_unavailable')) {
          displayError = 'SERVICE_UNAVAILABLE: Gemini 伺服器尖峰高負載 (503 High Demand)，請稍候重試或切換模型。';
        } else if (lowerErr.includes('quota') || lowerErr.includes('resource_exhausted') || lowerErr.includes('rate_limit') || lowerErr.includes('429')) {
          displayError = `QUOTA_EXCEEDED: 當前模型 '${model}' 已達免費用量上限 (429 Quota Exceeded)，建議切換至高額度模型 (如 Gemini 2.5 Flash-Lite) 繼續寫作。`;
        }

        const isUnavailable = httpStatus === 503 || lowerErr.includes('503') || lowerErr.includes('unavailable') || lowerErr.includes('high demand');
        const maxAttempts = isUnavailable ? 1 : 3;
        const nextAttempt = currentAttempt + 1;
        const activeSettings = loadStoredSettings();
        // If autoReconnect is disabled by user, never start auto-reconnect countdown
        const isRecoverableError = activeSettings.autoReconnect !== false && 
          ![400, 401, 403, 413].includes(httpStatus) &&
          !lowerErr.includes('quota') && 
          !lowerErr.includes('resource_exhausted') && 
          !lowerErr.includes('429') && 
          !lowerErr.includes('api_key_invalid');

        if (isRecoverableError && nextAttempt <= maxAttempts) {
          const retryAfterSeconds = Number(err?.retryAfterSeconds);
          const delaySeconds = isUnavailable
            ? Math.min(MAX_RETRY_DELAY_SECONDS, Math.max(5,
              Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? retryAfterSeconds : BUSY_RETRY_DELAY_SECONDS))
            : nextAttempt === 1 ? 2 : nextAttempt === 2 ? 3 : 5;
          session.reconnectState = {
            isReconnecting: true,
            attempt: nextAttempt,
            maxAttempts,
            countdown: delaySeconds,
            reason: displayError
          };
          notifySubscribers(storyId, session);

          const triggerReconnect = () => {
            clearReconnectTimers(storyId);
            startGeneration({
              storyId,
              prompt: promptText,
              model,
              systemInstruction,
              presetId,
              baseHistory,
              isRetry,
              initialAccumulated: accumulatedText,
              currentAttempt: nextAttempt,
              onStorySaved
            });
          };

          pendingReconnectsRef.current.set(storyId, triggerReconnect);

          let secondsLeft = delaySeconds;
          const intervalId = setInterval(() => {
            secondsLeft -= 1;
            session.reconnectState = {
              ...session.reconnectState,
              countdown: Math.max(0, secondsLeft)
            };
            notifySubscribers(storyId, session);
            if (secondsLeft <= 0) {
              clearInterval(intervalId);
            }
          }, 1000);
          reconnectIntervalsRef.current.set(storyId, intervalId);

          const timerId = setTimeout(() => {
            triggerReconnect();
          }, delaySeconds * 1000);
          reconnectTimersRef.current.set(storyId, timerId);

        } else {
          session.isGenerating = false;
          session.reconnectState = { isReconnecting: false, attempt: 0, maxAttempts: 3, countdown: 0 };
          session.error = displayError || '生成發生錯誤，您的對話已完整保存，請點擊重試。';
          abortControllersRef.current.delete(storyId);
          updateGeneratingStoryIds();

          // CRITICAL: Ensure messages state keeps the user's prompt (plus any partial text) and removes empty model slot
          if (accumulatedText && accumulatedText.trim()) {
            session.messages = [...newDisplayHistory, { role: 'model', text: accumulatedText }];
          } else {
            session.messages = [...newDisplayHistory];
          }

          try {
            await updateStory(storyId, {
              history: session.messages,
              model: effectiveModel,
              systemInstruction: systemInstruction || undefined,
              presetId: presetId || undefined
            });
            onStorySaved?.(storyId);
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('inkwell:story-saved', { detail: { storyId } }));
            }
          } catch (saveErr) {
            console.error(`[Generation] Failed to save dialogue history after error:`, saveErr);
          }

          notifySubscribers(storyId, session);
        }
      }
    }
  }, [clearReconnectTimers, notifySubscribers, updateGeneratingStoryIds]);

  const value: StoryGenerationContextType = {
    generatingStoryIds,
    isStoryGenerating,
    getGenerationSession,
    startGeneration,
    stopGeneration,
    cancelAutoReconnect,
    triggerImmediateReconnect,
    clearStoryError,
    subscribeToStory
  };

  return (
    <StoryGenerationContext.Provider value={value}>
      {children}
    </StoryGenerationContext.Provider>
  );
}

export function useStoryGeneration(): StoryGenerationContextType {
  const context = useContext(StoryGenerationContext);
  if (!context) {
    throw new Error('useStoryGeneration must be used within a StoryGenerationProvider');
  }
  return context;
}
