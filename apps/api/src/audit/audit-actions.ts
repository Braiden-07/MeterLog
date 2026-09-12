/**
 * THE AUDIT ACTION VOCABULARY — the single source, mirrored from ADR-012.
 *
 * Fourteen values over the eleven named mutation types. The three that are not
 * one-to-one with a mutation are worth knowing before reading the list:
 *
 *   * `asset_event.created` is the SECOND HALF of two mutations, not a mutation
 *     of its own — a status transition and a decommission each mutate `assets`
 *     AND write an `asset_events` row, so one user action produces two audit
 *     rows.
 *   * `user.created` belongs to `invite_member` / `register_tenant` rather than
 *     standing alone. `users` is audited because it is the only table in the
 *     schema carrying a secret, which is what makes ADR-011's redaction provable.
 *   * `membership.updated` is a total-function fallback in the trigger and is
 *     UNREACHABLE today. Its appearance in real data is a signal that a
 *     membership write path was added without extending this vocabulary.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN INLINE LIST IN THE DTO. The same fourteen
 * values are the Postgres `audit_action` enum, the filter's accepted input, the
 * OpenAPI enum and the response type. Four copies is three chances to drift, and
 * the drift would be silent in the worst direction: a value missing from the DTO
 * makes rows carrying it **unfilterable but still returned**, so the endpoint
 * would quietly answer a narrower question than the caller asked.
 *
 * The same argument the asset DTO makes for importing `ASSET_STATUSES` from
 * `lifecycle.ts` rather than restating them.
 *
 * **The database enum remains authoritative.** This list is asserted equal to it
 * against the live catalog in `test/db/audit.spec.ts`, so adding a value in a
 * migration without adding it here turns the suite red rather than shipping a
 * filter that silently cannot express it.
 */
export const AUDIT_ACTIONS = [
  'user.created',
  'membership.created',
  'membership.role_changed',
  'membership.revoked',
  'membership.updated',
  'asset.created',
  'asset.updated',
  'asset.status_changed',
  'asset.decommissioned',
  'asset_event.created',
  'reading.created',
  'maintenance.created',
  'maintenance.updated',
  'maintenance.deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The six audited tables (ADR-012). Used to validate the `tableName` drill-down
 * filter, so an unknown table is a 400 rather than a query that matches nothing.
 *
 * `tenants` is deliberately absent — ADR-012 records why it is not audited in
 * v1.0, and the day a tenant-mutating endpoint is proposed that decision is
 * revisited before the endpoint ships.
 */
export const AUDITED_TABLES = [
  'users',
  'memberships',
  'assets',
  'asset_events',
  'readings',
  'maintenance_records',
] as const;

export type AuditedTable = (typeof AUDITED_TABLES)[number];

/**
 * Page size for the audit trail, deliberately larger than the API-wide
 * `DEFAULT_LIMIT` / `MAX_LIMIT` (25 / 100) that `PaginationQuery` uses.
 *
 * Two reasons, both specific to this table: it is the highest-volume table in the
 * schema (ADR-012 prices it at roughly 2x reading volume), and its reader is an
 * auditor scanning a trail rather than a UI rendering a list, so large pages are
 * the ordinary request rather than an abuse.
 *
 * **Named here rather than by changing the shared constants**, so this stays a
 * reviewed audit-module choice instead of a quiet widening of every list endpoint
 * in the API. See ADR-014 for the divergence, including the fact that the other
 * endpoints REJECT an oversized limit where this one clamps.
 */
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
