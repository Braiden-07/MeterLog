import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService, TRANSACTION_OPTIONS } from '../common/prisma/prisma.service';
import { requireRequestContext } from '../common/request-context/request-context';
import { SessionData, SessionService } from '../common/session/session.service';

export interface Workspace {
  tenantId: string;
  name: string;
  role: string;
}

export interface Identity {
  user: { id: string; email: string };
  activeWorkspace: Workspace | null;
  workspaces: Workspace[];
}

/**
 * SQLSTATE for a unique violation.
 *
 * Matched on the CODE, never on the message. Postgres raises
 * `duplicate key value violates unique constraint "users_email_live_key"`, but
 * Prisma's raw-query wrapper flattens that to
 * `Raw query failed. Code: 23505. Message: Unique constraint failed: ` — the
 * constraint name is dropped entirely. A handler keyed on the constraint name
 * would silently never fire and turn a 409 into a 500 (ARCHITECTURE §16.2).
 */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  // -------------------------------------------------------------- register
  /**
   * Creates an organization: tenant + person + admin membership, atomically,
   * through `register_tenant` (ADR-006 §5). Deliberately does NOT log the user
   * in — registration stays single-purpose, and login is the path that resolves
   * workspaces.
   */
  async register(input: {
    tenantName: string;
    email: string;
    password: string;
  }): Promise<{ tenantId: string; userId: string }> {
    const passwordHash = await argonHash(input.password);

    try {
      const [row] = await this.prisma.$queryRawUnsafe<{ tenant_id: string; user_id: string }[]>(
        `SELECT tenant_id, user_id FROM public.register_tenant($1, $2::citext, $3)`,
        input.tenantName,
        input.email,
        passwordHash,
      );
      if (!row) throw new Error('register_tenant returned no row');
      return { tenantId: row.tenant_id, userId: row.user_id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // OPEN-1: registration is new-org-with-new-account only. An existing
        // person joins a second tenant by invitation (step 5), never by
        // re-registering.
        throw new ConflictException({
          error: { code: 'EMAIL_ALREADY_REGISTERED', message: 'That email is already registered.' },
        });
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------- login
  /**
   * Authenticate the person, then resolve workspaces (ADR-006 §5).
   *
   * Runs its own transaction and sets `app.current_user` by hand, because there
   * is no session yet — the interceptor cannot help a request that is in the
   * business of creating one.
   */
  async login(input: { email: string; password: string }): Promise<{
    cookie: string;
    identity: Identity;
  }> {
    const [credential] = await this.prisma.$queryRawUnsafe<
      { id: string; password_hash: string; deleted_at: Date | null }[]
    >(`SELECT id, password_hash, deleted_at FROM public.login_lookup($1::citext)`, input.email);

    // One generic failure for every reason, so the endpoint cannot be used to
    // enumerate accounts. The hash is still verified when no user was found, so
    // the response time does not answer the question either.
    const ok =
      credential !== undefined &&
      credential.deleted_at === null &&
      (await verifyQuietly(credential.password_hash, input.password));

    if (!ok || !credential) {
      await argonVerify(await dummyVerifyTarget(), input.password).catch(() => false);
      throw new UnauthorizedException({
        error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
      });
    }

    const workspaces = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, credential.id);
      return readWorkspaces(tx, credential.id);
    }, TRANSACTION_OPTIONS);

    // OPEN-2: zero live memberships is a successful login, not an auth failure.
    // The session is issued with no active tenant and `/auth/me` returns an empty
    // workspace list — that empty list is the client's signal. Tenant-scoped
    // requests then fail closed through the ordinary no-active-tenant path,
    // with no special casing anywhere.
    //
    // Exactly one membership auto-selects, so the single-tenant user's experience
    // matches the brief's original single-tenant flow in one step. More than one
    // issues the session with no active tenant and requires an explicit switch.
    const only = workspaces.length === 1 ? workspaces[0] : undefined;
    const session: SessionData = {
      userId: credential.id,
      activeTenantId: only?.tenantId ?? null,
      role: only?.role ?? null,
    };
    const cookie = await this.sessions.create(session);

    return {
      cookie,
      identity: {
        user: { id: credential.id, email: input.email },
        activeWorkspace: only ?? null,
        workspaces,
      },
    };
  }

  // ---------------------------------------------------------------- switch
  /**
   * Move the active workspace (ADR-006 §5, OPEN-3).
   *
   * The membership is verified against the database, under RLS, via the self
   * axis — never against the request's claim. A user who legitimately belongs to
   * several tenants is exactly the actor who could try to switch into one they
   * do not, so this is the membership model's boundary endpoint.
   */
  async switchTenant(cookie: string, tenantId: string): Promise<Identity> {
    const { tx, userId } = requireRequestContext();

    const [membership] = await tx.$queryRawUnsafe<{ role: string }[]>(
      `SELECT role::text AS role
         FROM public.memberships
        WHERE user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
          AND tenant_id = $1::uuid
          AND deleted_at IS NULL`,
      tenantId,
    );

    if (!membership) {
      // A well-formed, existent tenant the caller simply is not a member of ends
      // up here, which is the case that matters — not a malformed id.
      throw new ForbiddenException({
        error: { code: 'NOT_A_MEMBER', message: 'You are not a member of that workspace.' },
      });
    }

    await this.sessions.update(cookie, { activeTenantId: tenantId, role: membership.role });
    return this.identityFor(userId, tenantId, membership.role);
  }

  // -------------------------------------------------------------------- me
  async me(): Promise<Identity> {
    const { userId, tenantId, role } = requireRequestContext();
    return this.identityFor(userId, tenantId, role);
  }

  async logout(cookie: string | undefined): Promise<void> {
    if (cookie) await this.sessions.destroy(cookie);
  }

  // ------------------------------------------------------------- internals
  private async identityFor(
    userId: string,
    tenantId: string | null,
    role: string | null,
  ): Promise<Identity> {
    const { tx } = requireRequestContext();

    const [person] = await tx.$queryRawUnsafe<{ id: string; email: string }[]>(
      `SELECT id, email::text AS email FROM public.users WHERE id = $1::uuid`,
      userId,
    );
    const workspaces = await readWorkspaces(tx, userId);
    const active = workspaces.find((w) => w.tenantId === tenantId) ?? null;

    return {
      user: { id: userId, email: person?.email ?? '' },
      activeWorkspace: active ? { ...active, role: role ?? active.role } : null,
      workspaces,
    };
  }
}

/**
 * The user's live workspaces.
 *
 * `AND m.deleted_at IS NULL` is **the one documented app-side predicate in the
 * design** (ADR-006 §3, OPEN-5). Liveness cannot live in the `memberships` row
 * policies — the predicate would block the revoking UPDATE itself — so the self
 * axis returns revoked rows and every self-axis reader must filter them here.
 * Removing it makes a revoked workspace reappear in the switcher.
 */
async function readWorkspaces(tx: Prisma.TransactionClient, userId: string): Promise<Workspace[]> {
  const rows = await tx.$queryRawUnsafe<{ tenant_id: string; name: string; role: string }[]>(
    `SELECT m.tenant_id, t.name, m.role::text AS role
       FROM public.memberships m
       JOIN public.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1::uuid
        AND m.deleted_at IS NULL
      ORDER BY t.name`,
    userId,
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, name: r.name, role: r.role }));
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as { code?: string } | undefined;
    if (meta?.code === UNIQUE_VIOLATION) return true;
    if (error.code === 'P2002') return true;
  }
  return false;
}

/** argon2 throws on a malformed hash; a bad stored value must read as "wrong password". */
async function verifyQuietly(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A REAL argon2id hash, computed once, of a value nobody knows.
 *
 * Verified against on the no-such-user path so that branch costs the same as the
 * wrong-password branch — otherwise "unknown email" returns in microseconds
 * while "wrong password" takes an argon2 verify, and the timing difference is a
 * user-enumeration oracle that defeats the generic error message.
 *
 * It must be a hash argon2 will actually work on. A hand-written placeholder
 * would be rejected as malformed almost instantly, which reintroduces exactly
 * the timing gap it is supposed to close.
 */
let dummyHash: Promise<string> | null = null;
function dummyVerifyTarget(): Promise<string> {
  dummyHash ??= argonHash('a value that is never a real password');
  return dummyHash;
}
