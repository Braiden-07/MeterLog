import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
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
        routes.push({ method: RequestMethod[verb] ?? String(verb), path });
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
