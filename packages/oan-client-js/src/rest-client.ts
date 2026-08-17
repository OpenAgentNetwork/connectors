// Shared wrapper for OAN REST calls: uniform basePath joining, uniform auth headers, uniform
// error handling (see the OAN protocol document, openagentnetwork.ai/docs).
// Every business endpoint module (auth/gofers/match-requests/conversations/api-keys/events/attachments) reuses this file.
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { OanApiError } from './errors.js';

/** Auth mode for one REST call: no credentials (public endpoints such as login / pairing-code redemption), an OAN JWT, or a connector API key */
export type AuthMode = { kind: 'none' } | { kind: 'jwt'; token: string } | { kind: 'apiKey'; apiKey: string };

/** Uniform query-parameter shape: keys with undefined values are skipped when the URL is built, so callers never filter them out themselves */
type RequestQuery = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  auth?: AuthMode;
  query?: RequestQuery;
}

/** Multipart request options: body is always a FormData the caller has already populated; JSON bodies are not accepted */
interface MultipartRequestOptions {
  form: FormData;
  auth?: AuthMode;
  query?: RequestQuery;
}

// Joins basePath + path + query; shared by the JSON and multipart paths
function buildRequestUrl(baseUrl: string, path: string, query?: RequestQuery): URL {
  const url = new URL(baseUrl + OAN_REST_PATHS.basePath + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

// Builds auth headers from the AuthMode; shared by the JSON and multipart paths. Content-Type is
// added by each caller as needed (multipart must NEVER set Content-Type here — it has to be left
// to fetch, which generates the value with the boundary from the FormData)
function buildAuthHeaders(auth: AuthMode): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.kind === 'jwt') {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth.kind === 'apiKey') {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

// Uniform response handling: any non-2xx throws OanApiError, 204/empty bodies return undefined; shared by the JSON and multipart paths
async function parseResponse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON response body (e.g. a gateway's 502 HTML error page): never let the SyntaxError
    // escape the uniform error exit; wrap it in an OanApiError with the raw text attached, so
    // the caller's instanceof checks keep working
    throw new OanApiError(res.status, `HTTP ${res.status} ${path} (non-JSON response body)`, {
      body: text.slice(0, 512),
    });
  }
  if (!res.ok) {
    const body = json as Record<string, unknown> | undefined;
    const message = typeof body?.error === 'string' ? body.error : `HTTP ${res.status} ${path}`;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    throw new OanApiError(res.status, message, { code, body: json });
  }
  return json as T;
}

// Uniform REST request (JSON body): joins basePath + path, adds auth headers per AuthMode, and
// throws OanApiError on any non-2xx. Returns undefined on 204/empty bodies, which the caller
// handles per its own return type (usually void).
export async function oanRequest<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildRequestUrl(baseUrl, path, options.query);
  const headers = buildAuthHeaders(options.auth ?? { kind: 'none' });
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  return parseResponse<T>(res, path);
}

// Uniform multipart request: sits alongside oanRequest, dedicated to the file-upload endpoints.
// The method is fixed to POST (every multipart endpoint in the protocol has upload semantics),
// and Content-Type is never written by hand — fetch generates it, boundary included, from the
// FormData; a handwritten value would lose the boundary and break server-side parsing.
export async function oanRequestMultipart<T>(
  baseUrl: string,
  path: string,
  options: MultipartRequestOptions,
): Promise<T> {
  const url = buildRequestUrl(baseUrl, path, options.query);
  const headers = buildAuthHeaders(options.auth ?? { kind: 'none' });

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: options.form,
  });

  return parseResponse<T>(res, path);
}
