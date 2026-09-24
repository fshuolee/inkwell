export interface ModelError {
  status: number | null;
  retryAfterMs: number | null;
}

/** Gemini errors may wrap an HTTP error as text inside another error. */
export function classifyModelError(error: unknown): ModelError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = String(record.message ?? error ?? '');
  const explicitStatus = Number(record.status ?? record.code);
  const status = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
    ? explicitStatus
    : /(?:\b503\b|UNAVAILABLE|high demand)/i.test(message) ? 503
    : /(?:\b429\b|RESOURCE_EXHAUSTED|quota)/i.test(message) ? 429
    : /\b404\b|NOT_FOUND/i.test(message) ? 404
    : /\b403\b|PERMISSION_DENIED/i.test(message) ? 403
    : /\b401\b|UNAUTHENTICATED/i.test(message) ? 401
    : /\b400\b|INVALID_ARGUMENT/i.test(message) ? 400
    : null;
  const retrySeconds = message.match(/retry in ([\d.]+)s/i)?.[1]
    ?? message.match(/retryDelay[^\d]*([\d.]+)s/i)?.[1];
  const parsedRetry = retrySeconds ? Number(retrySeconds) : NaN;
  const explicitRetry = Number(record.retryAfterMs);
  return {
    status,
    retryAfterMs: Number.isFinite(explicitRetry) && explicitRetry > 0
      ? explicitRetry
      : Number.isFinite(parsedRetry) ? Math.ceil(parsedRetry * 1_000) : null,
  };
}

/** Prime the stream before selecting a model: SDK errors can occur on the first read. */
export async function openModelStream<T>(
  candidates: string[],
  createStream: (model: string) => Promise<AsyncIterable<T>>,
  canFallback: (error: unknown) => boolean,
  onFailure?: (model: string, error: unknown) => void,
  isReady: (chunk: T) => boolean = () => true,
): Promise<{ model: string; stream: AsyncIterable<T> }> {
  let lastError: unknown;
  for (const model of candidates) {
    let iterator: AsyncIterator<T> | undefined;
    try {
      iterator = (await createStream(model))[Symbol.asyncIterator]();
      const prefetched: T[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error('Model returned no content');
        prefetched.push(next.value);
        if (isReady(next.value)) break;
      }

      async function* replay(): AsyncGenerator<T> {
        try {
          for (const chunk of prefetched) yield chunk;
          while (true) {
            const next = await iterator!.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await iterator!.return?.();
        }
      }
      return { model, stream: replay() };
    } catch (error) {
      lastError = error;
      try { await iterator?.return?.(); } catch { /* Keep the original API error. */ }
      onFailure?.(model, error);
      if (!canFallback(error)) throw error;
    }
  }
  throw lastError ?? new Error('No model candidates are available');
}
