import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { REQUIRES_ROLE } from '../../src/common/auth/requires-role.decorator';
import { REQUIRES_SESSION } from '../../src/common/auth/requires-session.decorator';
import {
  WORKSPACE_EXEMPT_ROUTES,
  enforcesTenantExpectation,
  routeKey,
} from '../../src/common/tenant-context/tenant-context.interceptor';
import { APPEND_ONLY_TABLES, DEFINER_WRITTEN_APPEND_ONLY_TABLES, loadEnv } from '../db/helpers';

/**
 * The route-inventory guard — **the API-layer echo of catalog assertion 13.**
 *
 * Assertion 13 pins the DATABASE floor: a table declared append-only holds exactly
 * `SELECT, INSERT` for `meterlog_app`, so a mutating write is refused no matter
 * who issues it. This asserts the layer above: **no endpoint may even OFFER such a
 * write.**
 *
 * Both are needed, and neither substitutes for the other. Without the grant, an
 * endpoint could mutate an append-only row. Without this, an endpoint could exist
 * that always fails with a 500 from a `permission denied` — fail-closed, but a
 * broken API surface advertising an operation the database will never allow.
 *
 * In the shape of `EXPECTED_DEFINER_FUNCTIONS`: adding such a route cannot happen
 * quietly, because the suite goes red until someone edits the convention below in
 * a reviewed change.
 *
 * ---
 *
 * **THE APPEND-ONLY RESOURCE SET IS DERIVED, NOT LISTED.**
 *
 * A hardcoded list of paths is exactly the defect the teardown PR removed: twelve
 * hand-maintained cleanup sites, one of which did not know `readings` had landed.
 * So the resources here come from `APPEND_ONLY_TABLES` — the same declaration
 * CLAUDE.md documents and assertion 13 enforces — mapped to URL segments by the
 * single convention below.
 *
 * When `audit_log` joins `APPEND_ONLY_TABLES` at step 7, this guard extends by ONE
 * entry in that convention, and the set-equality check below fails until it is
 * added. It cannot silently stop covering a table.
 */

/**
 * table name -> the URL segment that exposes it.
 *
 * Explicit rather than inferred, because the mapping is not mechanical: `readings`
 * happens to match its table name, `asset_events` is exposed as `events` (nested
 * under `/assets/:id`, so the `asset_` prefix would be redundant in the path).
 * Guessing by stripping prefixes would work today and break on the first table
 * whose route does not follow the pattern.
 */
const TABLE_TO_SEGMENT: Readonly<Record<string, string>> = {
  asset_events: 'events',
  readings: 'readings',
  // STEP 7 PHASE 7A — the entry this file predicted above, added the moment
  // `audit_log` joined APPEND_ONLY_TABLES, because the set-equality check below
  // went red until it was. The guard did exactly what it was written to do.
  //
  // `GET /audit` lands at 7b (PROJECT_BRIEF §6 :166). This guard is about what
  // must NEVER exist on the segment — PATCH, PUT or DELETE — so it is in force
  // now, before the read surface, which is the useful order: the constraint on
  // the endpoints is written down before the endpoints are.
  //
  // And it is stricter here than for the other two. `asset_events` and `readings`
  // at least hold an INSERT grant; `audit_log` holds none, so a mutating route
  // would be refused by the database whatever it did (ADR-010).
  audit_log: 'audit',
};

/** HTTP methods that would mutate or remove an existing row. */
const MUTATING_METHODS = ['PATCH', 'PUT', 'DELETE'] as const;

interface RouteInfo {
  method: string;
  path: string;
  handler: object;
  controller: object;
}

/**
 * Every route Nest registered, read from **Nest's own decorator metadata** rather
 * than the Express router.
 *
 * Express internals were the first attempt and are the wrong source: in Express 4
 * `app.router` is a deprecated getter that THROWS, and `_router` is private and has
 * already changed shape once. A guard that silently stops finding routes is worse
 * than no guard — it passes.
 *
 * Walking `ModulesContainer` instead discovers every controller registered in the
 * app, so a new controller is covered automatically and nothing here needs editing
 * when one is added.
 */
function registeredRoutes(app: INestApplication): RouteInfo[] {
  const modules = app.get(ModulesContainer);
  const routes: RouteInfo[] = [];

  for (const module of modules.values()) {
    for (const controller of module.controllers.values()) {
      const type = controller.metatype;
      if (typeof type !== 'function') continue;

      const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      const proto = type.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;

        const routePath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (routePath === undefined || verb === undefined) continue;

        const path = `/${[base, routePath]
          .map((p) => p.replace(/^\/|\/$/g, ''))
          .filter(Boolean)
          .join('/')}`;
        routes.push({
          method: RequestMethod[verb] ?? String(verb),
          path,
          handler: handler as object,
          controller: type,
        });
      }
    }
  }

  return routes;
}

describe('route inventory — no endpoint may mutate an append-only resource', () => {
  let app: INestApplication;
  let routes: RouteInfo[];

  beforeAll(async () => {
    loadEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // Paths here are controller-relative (no /api/v1 prefix) — the guard matches on
    // path SEGMENTS, so the prefix is irrelevant to what it asserts.
    routes = registeredRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('found the router — the guard is not passing because it saw nothing', () => {
    // Without this, an Express internals change would silently empty the route
    // list and make every assertion below pass vacuously forever. The same
    // non-vacuity check the isolation matrix's case-count needs.
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.some((r) => r.method === 'GET' && r.path.includes('assets'))).toBe(true);
    expect(routes.some((r) => r.method === 'POST' && r.path.includes('assets'))).toBe(true);
  });

  it('every append-only table has a segment convention, and vice versa', () => {
    // Both directions, like the fixture registry. A table joining
    // APPEND_ONLY_TABLES without a segment would silently go unguarded; a stale
    // segment would guard nothing.
    const declared = [...APPEND_ONLY_TABLES].sort();
    const mapped = Object.keys(TABLE_TO_SEGMENT).sort();
    expect(
      mapped,
      'APPEND_ONLY_TABLES and TABLE_TO_SEGMENT disagree — add the new table to the convention',
    ).toEqual(declared);
  });

  it('no PATCH, PUT or DELETE route targets an append-only resource', () => {
    const segments = Object.values(TABLE_TO_SEGMENT);

    const offenders = routes.filter((r) => {
      if (!MUTATING_METHODS.includes(r.method as (typeof MUTATING_METHODS)[number])) return false;
      // Match on a path SEGMENT, so `/assets/:id/readings` is caught while a route
      // merely containing the word elsewhere is not.
      const parts = r.path.split('/').filter(Boolean);
      return parts.some((part) => segments.includes(part));
    });

    expect(
      offenders.map((r) => `${r.method} ${r.path}`),
      'an append-only resource must not expose a mutating route — the rows are immutable by grant (catalog assertion 13)',
    ).toEqual([]);
  });

  it('DELETE /assets/:id is deliberately NOT caught — assets is soft-deleted, not append-only', () => {
    // Pins the scope of the guard. `assets` carries `deleted_at`, and its DELETE is
    // the decommission transition (decision 9), which is a legitimate mutating
    // route. If this ever starts failing, the guard has become over-broad and would
    // block a correct endpoint.
    const deleteAsset = routes.filter((r) => r.method === 'DELETE' && /assets\/:id$/.test(r.path));
    expect(deleteAsset.length).toBe(1);
    expect(APPEND_ONLY_TABLES).not.toContain('assets');
  });

  it('the append-only resources DO expose reads and creates — except the one nothing may create', () => {
    // Pairs with the negative above the way assertion 10 pairs with 9: "no mutating
    // route" is trivially satisfied by a resource with no routes at all, which would
    // be fail-closed and broken.
    //
    // SPLIT BY WRITER AT STEP 7 PHASE 7A, and split rather than loosened. Until now
    // every append-only table was written BY THE API — `POST /assets/:id/readings`
    // creates a reading — so "exposes a GET and a POST" was the right pairing for
    // all of them. `audit_log` is the first whose writer is a SECURITY DEFINER
    // trigger and not the API, and for it a POST is not merely absent, it is
    // FORBIDDEN: the app role holds no INSERT at all (ADR-010), so an endpoint
    // offering one could only ever 500 on `permission denied`.
    //
    // So the stronger statement is asserted instead of the inapplicable one, and it
    // is asserted NOW rather than deferred with the read surface.
    for (const [table, segment] of Object.entries(TABLE_TO_SEGMENT)) {
      const onSegment = routes.filter((r) => r.path.split('/').includes(segment));

      if (DEFINER_WRITTEN_APPEND_ONLY_TABLES.includes(table)) {
        expect(
          onSegment.some((r) => r.method === 'POST'),
          `${segment} exposes a POST, but nothing may create an audit row through the API (ADR-010)`,
        ).toBe(false);

        // The GET arrives at step 7b — 7a's boundary is "no read endpoints". This
        // is written as a conditional rather than a comment so it TIGHTENS on its
        // own the moment any route lands on the segment: whatever appears there
        // must be a read.
        if (onSegment.length > 0) {
          expect(
            onSegment.every((r) => r.method === 'GET'),
            `${segment} exposes a non-GET route: ${onSegment
              .map((r) => `${r.method} ${r.path}`)
              .join(', ')}`,
          ).toBe(true);
        }
        continue;
      }

      expect(
        onSegment.some((r) => r.method === 'GET'),
        `${segment} exposes no GET`,
      ).toBe(true);
      expect(
        onSegment.some((r) => r.method === 'POST'),
        `${segment} exposes no POST`,
      ).toBe(true);
    }
  });
});

/**
 * THE §9 ROUTE/ROLE GUARD (G2, OPEN-18) — `ARCHITECTURE.md` §9 is the registry, the
 * live routes are the catalog, and the two must agree in BOTH directions.
 *
 * Same shape as the isolation suite's fixture-registry check: a route with no row
 * fails, a row with no route fails, and a row whose ✓/403 cells disagree with the
 * route's `@RequiresRole` fails. The exempt-route table (§9.4) is asserted equal to
 * the interceptor's `WORKSPACE_EXEMPT_ROUTES`, and its "Session required" column
 * against `@RequiresSession`.
 *
 * WHY THE DOCUMENT IS READ, RATHER THAN A TYPESCRIPT COPY OF IT. A constant in this
 * file would be checked against the code and never against §9, which is the gap
 * this guard exists to close: the matrix a reader consults could drift from the
 * routes with every test green. Parsing §9 makes a matrix edit and a decorator edit
 * the same reviewed change, or a red one.
 *
 * It lands with G2 because G2 is the first change that moves the matrix: the
 * default-deny exemption set is a new column of truth about every route.
 */
const ROLES = ['admin', 'technician', 'auditor'] as const;

interface MatrixRow {
  key: string;
  allowed: string[];
}

interface ExemptRow {
  key: string;
  sessionRequired: boolean;
}

function readMatrix(): { roles: MatrixRow[]; exempt: ExemptRow[]; duplicates: string[] } {
  const doc = readFileSync(resolve(__dirname, '../../../../docs/ARCHITECTURE.md'), 'utf8');
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 9.'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 10.'));
  if (start < 0 || end < 0) {
    throw new Error('ARCHITECTURE.md §9 not found — the guard cannot read its registry');
  }

  const roles: MatrixRow[] = [];
  const exempt: ExemptRow[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let header: string[] | null = null;

  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());

  for (const line of lines.slice(start, end)) {
    if (!line.trim().startsWith('|')) {
      header = null;
      continue;
    }
    const row = cells(line);
    if (!header) {
      header = row;
      continue;
    }
    if (row.every((c) => /^-+$/.test(c))) continue;

    const route = /^`(GET|POST|PUT|PATCH|DELETE) (\/[^`]*)`/.exec(row[0] ?? '');
    if (!route) throw new Error(`§9 row does not start with a METHOD /path cell: ${line}`);
    const key = `${route[1]} ${route[2]}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);

    if (header[1] === 'admin' && header[2] === 'technician' && header[3] === 'auditor') {
      const allowed = ROLES.filter((_, i) => {
        const cell = row[i + 1];
        if (cell !== '✓' && cell !== '403') throw new Error(`§9 cell must be ✓ or 403: ${line}`);
        return cell === '✓';
      });
      roles.push({ key, allowed: [...allowed] });
    } else if (header[0] === 'Exempt route') {
      const cell = row[1];
      if (cell !== 'yes' && cell !== 'no') {
        throw new Error(`§9.4 session cell must be yes or no: ${line}`);
      }
      exempt.push({ key, sessionRequired: cell === 'yes' });
    } else {
      throw new Error(`unrecognised §9 table header: ${header.join(' | ')}`);
    }
  }
  return { roles, exempt, duplicates };
}

describe('§9 route/role matrix — the document and the live routes agree in both directions', () => {
  let app: INestApplication;
  let routes: RouteInfo[];
  let reflector: Reflector;
  let matrix: ReturnType<typeof readMatrix>;

  const keyOf = (r: RouteInfo): string => `${r.method} ${r.path}`;
  const liveAllowed = (r: RouteInfo): string[] => {
    const required = reflector.getAllAndOverride<string[] | undefined>(REQUIRES_ROLE, [
      r.handler as never,
      r.controller as never,
    ]);
    // No @RequiresRole: every role is served — the ✓ ✓ ✓ row.
    return required && required.length > 0
      ? ROLES.filter((role) => required.includes(role))
      : [...ROLES];
  };

  beforeAll(async () => {
    loadEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    routes = registeredRoutes(app);
    reflector = app.get(Reflector);
    matrix = readMatrix();
  });

  afterAll(async () => {
    await app.close();
  });

  it('read a real matrix — not passing because it parsed nothing', () => {
    expect(matrix.roles.length).toBeGreaterThan(10);
    expect(matrix.exempt.length).toBeGreaterThan(0);
    // Every registered route accounted for — no silent truncation of the parse.
    expect(matrix.roles.length + matrix.exempt.length).toBe(routes.length);
    expect(matrix.duplicates, 'a route appears in §9 more than once').toEqual([]);
  });

  it('the interceptor keys routes exactly as this guard enumerates them', () => {
    // WORKSPACE_EXEMPT_ROUTES is matched on routeKey(); this guard matches on the
    // enumerated method + path. If the two constructions ever diverged, §9.4 could
    // agree with the set while the interceptor exempted something else.
    for (const r of routes) {
      expect(routeKey(reflector, r.handler, r.controller)).toBe(keyOf(r));
    }
  });

  it('§9.4 equals the interceptor exempt set, and each row matches @RequiresSession', () => {
    expect(matrix.exempt.map((r) => r.key).sort()).toEqual([...WORKSPACE_EXEMPT_ROUTES].sort());

    for (const row of matrix.exempt) {
      const live = routes.find((r) => keyOf(r) === row.key);
      expect(live, `§9.4 lists ${row.key}, which is not a registered route`).toBeDefined();
      const requiresSession = Boolean(
        reflector.getAllAndOverride<boolean>(REQUIRES_SESSION, [
          live!.handler as never,
          live!.controller as never,
        ]),
      );
      expect(requiresSession, `§9.4 "Session required" for ${row.key}`).toBe(row.sessionRequired);
      // An exempt route with a role gate would be a contradiction: a role only
      // exists inside a workspace.
      expect(liveAllowed(live!), `${row.key} is exempt but role-gated`).toEqual([...ROLES]);
    }
  });

  it('every live route has exactly one §9 row, and every §9 row is a live route', () => {
    const documented = new Set([
      ...matrix.roles.map((r) => r.key),
      ...matrix.exempt.map((r) => r.key),
    ]);
    const live = new Set(routes.map(keyOf));

    const undocumented = [...live].filter((k) => !documented.has(k)).sort();
    const stale = [...documented].filter((k) => !live.has(k)).sort();
    expect(undocumented, 'routes with no row in ARCHITECTURE.md §9').toEqual([]);
    expect(stale, 'rows in ARCHITECTURE.md §9 for routes that do not exist').toEqual([]);

    const both = matrix.roles.map((r) => r.key).filter((k) => WORKSPACE_EXEMPT_ROUTES.has(k));
    expect(both, 'a route cannot be both tenant-scoped (a role table) and exempt (§9.4)').toEqual(
      [],
    );
  });

  /**
   * THE `X-Expected-Tenant` ENFORCED SET (OPEN-15) — the guard the exempt list's
   * new second meaning owes.
   *
   * `WORKSPACE_EXEMPT_ROUTES` now says two things at once: exempt from needing an
   * active workspace, AND exempt from tenant-expectation enforcement. Reusing one
   * list for two ideas is deliberate — a second list is a second thing to forget
   * — but it means a future exemption added for the FIRST reason silently waives
   * the second. If someone exempts a tenant-scoped write, enforcement quietly
   * stops covering it and nothing else in the suite would notice.
   *
   * So the enforced set is asserted here, derived from the live routes, in both
   * directions: it is non-empty, it still contains every admin write, and it
   * still excludes the switch.
   */
  describe('the X-Expected-Tenant enforced set (OPEN-15)', () => {
    const enforced = (): string[] =>
      routes.filter((r) => enforcesTenantExpectation(r.method, keyOf(r))).map(keyOf).sort();

    it('is not empty — enforcement covers something', () => {
      // The vacuity guard. An empty enforced set would make every OPEN-15
      // assertion below trivially true and the mitigation a no-op.
      expect(enforced().length).toBeGreaterThan(0);
    });

    it('contains all four admin writes — the routes the row was opened for', () => {
      // These are the four the admin user-management slice added; all four send
      // the header from the client and none of them enforced it until this PR.
      expect(enforced()).toEqual(
        expect.arrayContaining([
          'POST /users',
          'POST /users/pending/:membershipId/token',
          'PATCH /users/:id',
          'DELETE /users/:id',
        ]),
      );
    });

    it('excludes POST /auth/switch — the deadlock the naive by-method rule ships', () => {
      // `switchTo` sends the OLD tenant as its expectation, so enforcing here
      // would 409 exactly the request a stale-view client needs to recover.
      // `tenant-expectation.spec.ts` proves the behaviour; this pins the rule.
      expect(enforced()).not.toContain('POST /auth/switch');
    });

    it('excludes every exempt route and every GET, and nothing else', () => {
      // Stated as an equality rather than a spot-check, so the set cannot drift
      // in either direction without this failing.
      const expected = routes
        .filter((r) => r.method !== 'GET' && !WORKSPACE_EXEMPT_ROUTES.has(keyOf(r)))
        .map(keyOf)
        .sort();
      expect(enforced()).toEqual(expected);

      for (const key of WORKSPACE_EXEMPT_ROUTES) {
        expect(enforced(), `${key} is exempt but enforced`).not.toContain(key);
      }
    });
  });

  it('every role row matches its route’s @RequiresRole, cell by cell', () => {
    const mismatches = matrix.roles
      .map((row) => {
        const live = routes.find((r) => keyOf(r) === row.key);
        return { key: row.key, documented: row.allowed, actual: live ? liveAllowed(live) : null };
      })
      .filter((m) => JSON.stringify(m.documented) !== JSON.stringify(m.actual));
    expect(mismatches, 'ARCHITECTURE.md §9 disagrees with the decorators').toEqual([]);
  });
});
