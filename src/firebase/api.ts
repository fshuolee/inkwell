import { auth } from './auth';

/** Attach a fresh Firebase ID token to each request using server-side Gemini quota. */
export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const user = auth.currentUser;
  if (!user) throw new Error('Please sign in to use the API.');

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
  return fetch(input, { ...init, headers });
}
