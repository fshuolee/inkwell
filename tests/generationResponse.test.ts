import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGenerationResponse } from '../src/context/generationResponse';

test('rejects a successful HTML startup page instead of treating it as story text', () => {
  const response = new Response('<!doctype html><title>Starting Server...</title>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

  assert.throws(() => assertGenerationResponse(response), {
    code: 'SERVER_STARTING',
    status: 503,
  });
});

test('accepts the plain-text generation stream', () => {
  const response = new Response('The story continues.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

  assert.doesNotThrow(() => assertGenerationResponse(response));
});

test('lets JSON API errors reach the existing status handler', () => {
  const response = new Response('{"error":"Please sign in"}', {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  assert.doesNotThrow(() => assertGenerationResponse(response));
});
