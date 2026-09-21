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

/**
 * Codes the client resets its cache on. Both mean "you have no workspace now".
 *
 * **`FORBIDDEN_ROLE` IS DELIBERATELY NOT HERE — do not "simplify" it in.** It is
 * a 403 like the two above and looks like it belongs, which is exactly why this
 * note exists. The two codes here mean the caller has **no workspace**, so every
 * tenant-scoped row in the cache is now unreadable and the only correct response
 * is to discard all of it. `FORBIDDEN_ROLE` means the caller still HAS this
 * workspace and may still read it — they simply may not perform the action they
 * just attempted, typically because they were demoted mid-session.
 *
 * Adding it here would clear the whole cache and bump the generation, remounting
 * the shell and flickering data the caller is still entitled to see. The correct
 * response is narrower and lives in `WorkspaceSession.handleApiError`: invalidate
 * identity only, so the role corrects itself and the admin section disappears on
 * its own. Reset means "no workspace"; role-correction means "identity only".
 */
export const RESET_CODES = ['NO_ACTIVE_WORKSPACE', 'MEMBERSHIP_REVOKED'] as const;
export type ResetCode = (typeof RESET_CODES)[number];

/**
 * The role gate's refusal (ARCHITECTURE §9). Distinct from the definer bodies'
 * `NOT_ADMIN`, which is the same 403 raised one layer deeper — the two carry
 * different codes on purpose so a test asserting one cannot be satisfied by the
 * other layer. Both mean the caller's role is not what the UI believed.
 */
export const FORBIDDEN_ROLE = 'FORBIDDEN_ROLE';
export const NOT_ADMIN = 'NOT_ADMIN';

/**
 * The 409 a state-changing request gets when its `X-Expected-Tenant` names a
 * workspace other than the one the server just verified as active (OPEN-15).
 *
 * **A THIRD POLICY CLASS, not a variant of the two above.** It is neither "you
 * have no workspace" (reset) nor "your role is not what you thought"
 * (role-correction): the workspace is valid and the role is right — the TAB is
 * simply behind, because the active workspace changed underneath it, typically
 * in another tab. The write it was carrying did not happen.
 *
 * Matched against the exact string the interceptor throws
 * (`tenant-context.interceptor.ts`); the server keeps it distinct from every
 * other refusal precisely so the client can respond differently.
 */
export const TENANT_MISMATCH = 'TENANT_MISMATCH';

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

  /**
   * True when the caller's ROLE is not what the client believed, but their
   * workspace is intact — a mid-session demotion being the ordinary cause.
   *
   * Deliberately a separate predicate from `isWorkspaceReset` rather than a
   * widening of it, because the two call for opposite responses: that one
   * discards everything, this one refreshes identity and leaves the cache alone.
   * Both layers that can refuse on role are included — the gate's
   * `FORBIDDEN_ROLE` and the definer body's `NOT_ADMIN` — because from the
   * client's side they mean the same thing, even though the server keeps them
   * distinguishable on purpose.
   */
  get isRoleCorrection(): boolean {
    return this.code === FORBIDDEN_ROLE || this.code === NOT_ADMIN;
  }

  /**
   * True when the caller's ACTIVE WORKSPACE is not what the client believed —
   * the tab is behind, and the write it just attempted did not happen.
   *
   * One getter per policy class, like the two above, and for the same reason:
   * three predicates that can be read side by side are three responses that can
   * be told apart. Folding this into either of the others would be wrong in
   * opposite directions — `isWorkspaceReset` would discard a cache the caller is
   * still entitled to, and `isRoleCorrection` would leave the tab pointed at a
   * workspace the server no longer considers active.
   */
  get isTenantMismatch(): boolean {
    return this.code === TENANT_MISMATCH;
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
