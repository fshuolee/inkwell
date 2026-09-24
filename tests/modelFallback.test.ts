import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyModelError, openModelStream } from '../modelFallback';

test('recognizes a nested high demand error', () => {
  const error = new Error('{"error":{"message":"{\\"error\\":{\\"code\\":503,\\"status\\":\\"UNAVAILABLE\\"}}","code":503}}');
  assert.equal(classifyModelError(error).status, 503);
  assert.equal(classifyModelError({ status: 429, message: 'retry in 4.5s' }).retryAfterMs, 4_500);
  assert.equal(classifyModelError(new Error('403 PERMISSION_DENIED')).status, 403);
});

test('switches model when the first stream read fails with 503', async () => {
  const opened: string[] = [];
  const result = await openModelStream(['busy', 'available'], async model => {
    opened.push(model);
    if (model === 'busy') {
      return { async *[Symbol.asyncIterator]() { throw new Error('503 UNAVAILABLE'); yield ''; } };
    }
    return { async *[Symbol.asyncIterator]() { yield 'story'; } };
  }, error => classifyModelError(error).status === 503);

  const chunks: string[] = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  assert.deepEqual(opened, ['busy', 'available']);
  assert.equal(result.model, 'available');
  assert.deepEqual(chunks, ['story']);
});

test('switches model if metadata arrives before a 503 failure', async () => {
  const opened: string[] = [];
  const result = await openModelStream(['busy', 'available'], async model => {
    opened.push(model);
    if (model === 'busy') {
      return { async *[Symbol.asyncIterator]() { yield ''; throw new Error('503 UNAVAILABLE'); } };
    }
    return { async *[Symbol.asyncIterator]() { yield 'story'; } };
  }, error => classifyModelError(error).status === 503, undefined, chunk => chunk.length > 0);

  const chunks: string[] = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  assert.deepEqual(opened, ['busy', 'available']);
  assert.deepEqual(chunks, ['story']);
});

test('does not hide a non-retryable error behind other models', async () => {
  const opened: string[] = [];
  await assert.rejects(openModelStream(['first', 'second'], async model => {
    opened.push(model);
    throw new Error('400 invalid request');
  }, error => classifyModelError(error).status === 503));
  assert.deepEqual(opened, ['first']);
});

test('propagates a failure after text starts without replaying another model', async () => {
  const opened: string[] = [];
  const result = await openModelStream(['partial', 'other'], async model => {
    opened.push(model);
    return {
      async *[Symbol.asyncIterator]() {
        yield 'first sentence';
        throw new Error('503 UNAVAILABLE');
      },
    };
  }, error => classifyModelError(error).status === 503);

  const chunks: string[] = [];
  await assert.rejects(async () => {
    for await (const chunk of result.stream) chunks.push(chunk);
  });
  assert.deepEqual(chunks, ['first sentence']);
  assert.deepEqual(opened, ['partial']);
});
