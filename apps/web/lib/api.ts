import { errorEnvelopeSchema } from '@meterlog/shared';

/**
 * The API client.
 *
 * RELATIVE BASE URL, deliberately. Every request goes to the web origin and is
 * forwarded by the Next rewrite (next.config.mjs). There is no API origin in the
 * browser bundle, so there is no way for a component to bypass the proxy and
 * reintroduce a cross-site cookie.
 */
export const API_BASE = '/api/v1';

/** Codes the client resets its cache on. Both mean "you have no workspace now". */
export const RESET_CODES = ['NO_ACTIVE_WORKSPACE', 'MEMBERSHIP_REVOKED'] as const;
export type ResetCode = (typeof RESET_CODES)[number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True for the two codes that mean the cache must be discarded. */
  get isWorkspaceReset(): boolean {
    return (RESET_CODES as readonly string[]).includes(this.code);
  }
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * The tenant the CALLER believes is active. Sent as `X-Expected-Tenant`.
   *
   * INERT PLUMBING, AND LABELLED AS SUCH SO NOBODY RELIES ON IT. The server does
   * not read this header yet (OPEN-15). Sending it now means the enforcement slice
   * can turn it on without a second frontend change, but until it does **this
   * header closes nothing**: a write issued under workspace A that arrives after a
   * switch to B is still applied under B. The client-side guarantee in this slice
   * covers late READS (they are cancelled and discarded by cache generation), not
   * late writes.
   */
  expectedTenant?: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  request<T>(req: ApiRequest): Promise<T>;
}

/** Parses the project error envelope, falling back when a body is not one. */
function errorFrom(status: number, payload: unknown): ApiError {
  const parsed = errorEnvelopeSchema.safeParse(payload);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(status, code, message, details);
  }
  return new ApiError(status, 'UNEXPECTED', `Request failed with status ${status}.`);
}

export function createApiClient(fetchImpl: FetchLike): ApiClient {
  return {
    async request<T>({ method = 'GET', path, body, signal, expectedTenant }: ApiRequest): Promise<T> {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (expectedTenant) headers['x-expected-tenant'] = expectedTenant;

      const response = await fetchImpl(`${API_BASE}${path}`, {
        method,
        headers,
        // Same-origin by construction; stated rather than left to the default so
        // the cookie requirement is visible at the call site.
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      const payload: unknown = text.length > 0 ? JSON.parse(text) : undefined;

      if (!response.ok) throw errorFrom(response.status, payload);
      return payload as T;
    },
  };
}
