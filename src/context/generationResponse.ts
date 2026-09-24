/** The generation endpoint streams plain text; a hosted startup page is not story content. */
export function assertGenerationResponse(response: Response): void {
  const contentType = response.headers.get('Content-Type') || '';
  const mediaType = contentType.toLowerCase().split(';', 1)[0].trim();
  if (mediaType !== 'text/html' && (!response.ok || mediaType === 'text/plain')) return;

  throw Object.assign(new Error('SERVER_STARTING: The application server is not ready. Please retry shortly.'), {
    code: 'SERVER_STARTING',
    status: 503,
    retryAfterSeconds: 5,
  });
}
