const MAX_BODY_BYTES = 2048;
const REQUEST_HEADERS = ['cookie', 'origin', 'content-type'] as const;
const RESPONSE_HEADERS = [
  'content-type', 'location', 'cache-control', 'content-security-policy', 'referrer-policy',
  'x-content-type-options', 'x-frame-options', 'permissions-policy', 'cross-origin-opener-policy',
] as const;

function secureHeaders(source?: Headers): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = source?.get(name);
    if (value !== null && value !== undefined) headers.set(name, value);
  }
  const setCookies = source && typeof source.getSetCookie === 'function'
    ? source.getSetCookie()
    : source?.get('set-cookie') ? [source.get('set-cookie')!] : [];
  for (const value of setCookies) headers.append('set-cookie', value);
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', headers.get('content-security-policy') ?? "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  headers.set('referrer-policy', headers.get('referrer-policy') ?? 'no-referrer');
  headers.set('x-content-type-options', headers.get('x-content-type-options') ?? 'nosniff');
  headers.set('x-frame-options', headers.get('x-frame-options') ?? 'DENY');
  return headers;
}

function errorResponse(status: number, code: string, reason: string): Response {
  const headers = secureHeaders();
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ status: 'ERROR', code, reason }), { status, headers });
}

async function readLimitedBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function createOnboardingProxy(authorityUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(authorityUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('AUTHORITY_URL must be an HTTP(S) service URL without credentials, query, or fragment.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;

  return async (request: Request): Promise<Response> => {
    const incoming = new URL(request.url);
    if (incoming.pathname !== '/onboarding' && !incoming.pathname.startsWith('/onboarding/')) {
      return errorResponse(404, 'INVALID_REQUEST', 'Onboarding route not found.');
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return errorResponse(405, 'INVALID_REQUEST', 'Only GET and POST are allowed for onboarding.');
    }

    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === 'POST') {
      const contentLength = request.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
        return errorResponse(Number(contentLength) > MAX_BODY_BYTES ? 413 : 400, 'INVALID_REQUEST', 'Onboarding request body is invalid or too large.');
      }
      const limited = await readLimitedBody(request.body);
      if (limited === null) return errorResponse(413, 'INVALID_REQUEST', 'Onboarding request body is too large.');
      body = limited;
    }

    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const path = incoming.pathname.replace(/^\/+/, '');
    const target = new URL(`${path}${incoming.search}`, base);
    let upstream: Response;
    try {
      upstream = await fetcher(target, {
        method: request.method,
        headers,
        ...(body && body.byteLength ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
      });
    } catch {
      return errorResponse(502, 'SERVICE_UNAVAILABLE', 'Trusted onboarding service is unavailable.');
    }

    const responseBody = [204, 304].includes(upstream.status) ? null : upstream.body;
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: secureHeaders(upstream.headers),
    });
  };
}
