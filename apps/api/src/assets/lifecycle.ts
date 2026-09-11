/**
 * The asset lifecycle transition graph — **the only place the
 * transition -> event_type mapping exists.**
 *
 * ARCHITECTURE §9.2 records the contract; this is its single implementation.
 *
 * ---
 *
 * **WHY THE GRAPH IS KEYED ON THE EVENT TYPE AND NOT ON THE TARGET STATUS.**
 *
 * The obvious shape for this file is a lookup from the status being moved to:
 *
 *     const statusToEventType = { active: 'activated', maintenance: 'maintenance_started', ... }
 *
 * **That shape is wrong by construction, and nothing about it looks wrong.**
 * `activated` and `maintenance_completed` BOTH land on status `active`, so such a
 * map has two correct answers for one key and must silently pick one. An asset
 * coming back from maintenance would be recorded as having been `activated` — the
 * event log would still replay to the right *status*, so every status assertion
 * would pass, while the history quietly lost the distinction between
 * commissioning a meter and finishing a repair on it. That is the whole reason to
 * keep an append-only lifecycle log rather than reading `assets.status`.
 *
 * So the CLIENT NAMES THE TRANSITION, not the target state. `event_type` is the
 * key, the target status is derived from it, and the legal source statuses are
 * declared alongside. A status-keyed map is then not merely discouraged — there is
 * no place to put one, because no code path ever starts from "the new status".
 *
 * `test/api/assets-transitions.spec.ts` carries the load-bearing journey that
 * catches the naive map if anyone reintroduces it.
 */

export const ASSET_STATUSES = ['installed', 'active', 'maintenance', 'decommissioned'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_EVENT_TYPES = [
  'created',
  'installed',
  'activated',
  'maintenance_started',
  'maintenance_completed',
  'decommissioned',
] as const;
export type AssetEventType = (typeof ASSET_EVENT_TYPES)[number];

/** One edge of the graph: which statuses it may be applied from, and where it lands. */
export interface Transition {
  readonly from: readonly AssetStatus[];
  readonly to: AssetStatus;
}

/**
 * The transitions a client may POST to `/assets/:id/events`.
 *
 * Deliberately NOT all six event types. The other three exist in the enum and are
 * emitted by the system, never posted:
 *   * `created` / `installed` — the genesis pair, written by `POST /assets` (3b).
 *   * `decommissioned` — written by `DELETE /assets/:id`, which must also set
 *     `deleted_at` to satisfy `assets_decommissioned_iff_deleted`.
 *
 * `installed -> maintenance` is deliberately ABSENT. The `maintenance` status means
 * "withdrawn from service"; an uncommissioned asset is already out of service, so
 * the edge conveys nothing, and maintenance WORK is recorded in
 * `maintenance_records` (a separate axis, phase 4/6b). One edge to add later if
 * operations disagree — easy to add, hard to remove once clients depend on it.
 */
export const POSTABLE_TRANSITIONS: Readonly<Record<string, Transition>> = {
  activated: { from: ['installed'], to: 'active' },
  maintenance_started: { from: ['active'], to: 'maintenance' },
  maintenance_completed: { from: ['maintenance'], to: 'active' },
};

/**
 * Where `decommissioned` may be applied from. `DELETE /assets/:id` owns it.
 *
 * `installed` is included: assets are scrapped before commissioning (damaged on
 * install, wrong spec). Refusing that would strand such an asset in `installed`
 * with no legal exit, which breaks §9.2's invariant on the one transition that
 * matters most.
 *
 * `decommissioned` is absent because the state is TERMINAL. Phase 1's
 * `assets_tenant_serial_live_key ... WHERE deleted_at IS NULL` already presupposes
 * this: re-registering a decommissioned serial only makes sense if a returning
 * asset is a NEW ROW rather than a reactivation. Allowing reactivation would
 * contradict a merged decision.
 */
export const DECOMMISSION_FROM: readonly AssetStatus[] = ['installed', 'active', 'maintenance'];

/** Event types the system emits but a client may not post, with the path that owns each. */
export const SYSTEM_ONLY_EVENTS: Readonly<Record<string, { code: string; message: string }>> = {
  created: {
    code: 'ASSET_EVENT_GENESIS_ONLY',
    message: 'created is emitted when an asset is registered. Use POST /assets.',
  },
  installed: {
    code: 'ASSET_EVENT_GENESIS_ONLY',
    message: 'installed is emitted when an asset is registered. Use POST /assets.',
  },
  decommissioned: {
    code: 'ASSET_EVENT_USE_DELETE',
    message: 'Decommissioning also retires the asset. Use DELETE /assets/:id.',
  },
};

/**
 * The `payload` for a transition (decision 10). Additive-only: future keys may be
 * added, existing keys are never repurposed or removed, because these rows are
 * append-only and will be replayed by code newer than they are.
 */
export function transitionPayload(from: AssetStatus | null, to: AssetStatus): string {
  return JSON.stringify({ from, to });
}
