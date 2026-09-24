import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparePartialRetry } from '../src/context/generationRetry';

test('partial retry retains the user prompt and model fragment', () => {
  const base = [{ role: 'user' as const, text: 'Earlier turn' }, { role: 'model' as const, text: 'Earlier reply' }];
  const retry = preparePartialRetry(base, 'Write the next chapter', 'The door opened');

  assert.deepEqual(retry.displayHistory.at(-1), { role: 'user', text: 'Write the next chapter' });
  assert.deepEqual(retry.apiHistory.at(-1), { role: 'model', text: 'The door opened' });
  assert.match(retry.apiPrompt, /Continue/);
  assert.deepEqual(base, [{ role: 'user', text: 'Earlier turn' }, { role: 'model', text: 'Earlier reply' }]);
});
