export interface HistoryMessage {
  role: 'user' | 'model';
  text: string;
}

export const CONTINUATION_PROMPT = 'Continue the previous response exactly where it stopped.';

/** Preserve the original user turn and partial output when resuming a failed stream. */
export function preparePartialRetry(
  baseHistory: HistoryMessage[],
  originalPrompt: string,
  partialText: string,
) {
  const displayHistory: HistoryMessage[] = [
    ...baseHistory,
    { role: 'user', text: originalPrompt.trim() },
  ];
  return {
    displayHistory,
    apiHistory: [...displayHistory, { role: 'model' as const, text: partialText }],
    apiPrompt: CONTINUATION_PROMPT,
  };
}
