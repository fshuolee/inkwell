import { importX509, jwtVerify } from 'jose';

const CERTIFICATE_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CERTIFICATE_TIMEOUT_MS = 5_000;

type CertificateMap = Record<string, string>;

let certificates: CertificateMap = {};
let certificatesExpireAt = 0;
let pendingCertificates: Promise<void> | null = null;

/** Firebase rotates signing certificates. Cache them only for Google's advertised max-age. */
async function getCertificates(): Promise<CertificateMap> {
  if (Date.now() < certificatesExpireAt) return certificates;

  if (!pendingCertificates) {
    pendingCertificates = (async () => {
      const response = await fetch(CERTIFICATE_URL, { signal: AbortSignal.timeout(CERTIFICATE_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Firebase certificate request failed: ${response.status}`);

      const nextCertificates: unknown = await response.json();
      if (!nextCertificates || typeof nextCertificates !== 'object' || Array.isArray(nextCertificates)) {
        throw new Error('Firebase certificate response was invalid');
      }

      const maxAge = Number(response.headers.get('cache-control')?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 0);
      certificates = nextCertificates as CertificateMap;
      certificatesExpireAt = Date.now() + maxAge * 1_000;
    })().finally(() => {
      pendingCertificates = null;
    });
  }

  await pendingCertificates;
  return certificates;
}

/** Verify a Firebase ID token before an API route uses server-side Gemini quota. */
export async function verifyFirebaseToken(token: string, projectId: string): Promise<string> {
  const { payload } = await jwtVerify(token, async (header) => {
    if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid Firebase token header');
    const certificate = (await getCertificates())[header.kid];
    if (typeof certificate !== 'string') throw new Error('Unknown Firebase signing key');
    return importX509(certificate, 'RS256');
  }, {
    algorithms: ['RS256'],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });

  const now = Math.floor(Date.now() / 1_000);
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 ||
      typeof payload.exp !== 'number' || payload.exp <= now ||
      typeof payload.iat !== 'number' || payload.iat > now ||
      typeof payload.auth_time !== 'number' || payload.auth_time > now) {
    throw new Error('Invalid Firebase token claims');
  }
  return payload.sub;
}
