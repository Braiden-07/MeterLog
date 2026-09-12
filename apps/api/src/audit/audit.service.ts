import { Injectable } from '@nestjs/common';

import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor';
import { requireRequestContext } from '../common/request-context/request-context';

import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from './audit-actions';
import { AuditPage, AuditRow, ListAuditQuery, invalidRange } from './dto/audit.dto';

interface RawRow {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  table_name: string;
  row_id: string;
  action: string;
  payload: unknown;
  created_at: Date;
  cursor_key: string;
}

const toRow = (r: RawRow): AuditRow => ({
  id: r.id,
  actorUserId: r.actor_user_id,
  actorRole: r.actor_role,
  tableName: r.table_name,
  rowId: r.row_id,
  action: r.action,
  payload: r.payload,
  createdAt: r.created_at,
});

/**
 * The audit read surface (step 7 phase 7b, ADR-014).
 *
 * **THERE IS NO `tenant_id` IN THE WHERE CLAUSE, AND THERE MUST NOT BE.** The
 * query runs on the request transaction, where the interceptor has set
 * `app.current_tenant`, so the canonical policy scopes the result. An
 * application-layer tenant predicate would not make isolation stronger — it would
 * make a policy regression **invisible**, because the redundant filter would keep
 * returning correct rows after the thing that actually protects the data stopped
 * working. Same rule as `AssetsService.list` and `MembershipsService.list`, and
 * the reason the cross-tenant negative in `audit-read.spec.ts` is evidence about
 * RLS rather than about this file.
 *
 * Raw SQL rather than the query builder, matching the other services, because
 * keyset pagination needs a row-wise comparison `(created_at, id) < (?, ?)` that
 * the builder cannot express.
 */
@Injectable()
export class AuditService {
  async list(query: ListAuditQuery): Promise<AuditPage> {
    const { tx } = requireRequestContext();

    // THE CLAMP (ADR-014). Silent by design and reported back in the envelope:
    // a rejected oversized request leaves the client no forward path, a clamped
    // one returns rows plus a cursor. `limit` is absent from the DTO's `@Max`
    // precisely so this line is reachable — see the DTO comment.
    const requested = query.limit ?? AUDIT_DEFAULT_LIMIT;
    const limit = Math.min(requested, AUDIT_MAX_LIMIT);

    const where: string[] = [];
    const params: unknown[] = [];

    if (query.action) {
      params.push(query.action);
      where.push(`al.action = $${params.length}::public.audit_action`);
    }

    // Drill-down. `tableName` alone is valid ("everything that happened to any
    // maintenance record"); `rowId` alone is refused by the DTO's cross-field
    // validator before reaching here.
    if (query.tableName) {
      params.push(query.tableName);
      where.push(`al.table_name = $${params.length}`);
    }
    if (query.rowId) {
      params.push(query.rowId);
      where.push(`al.row_id = $${params.length}::uuid`);
    }

    if (query.actorUserId) {
      params.push(query.actorUserId);
      where.push(`al.actor_user_id = $${params.length}::uuid`);
    }

    // HALF-OPEN [from, to) so consecutive windows tile without double-counting a
    // row that lands exactly on a boundary. See the DTO.
    if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
      throw invalidRange();
    }
    if (query.from) {
      params.push(query.from);
      where.push(`al.created_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`al.created_at < $${params.length}::timestamptz`);
    }

    if (query.cursor) {
      const { k, i } = decodeCursor(query.cursor);
      params.push(k, i);
      // THE ROW-WISE COMPARISON IS THE KEYSET, and on this table the tie it
      // breaks is the COMMON CASE rather than an edge: one logical mutation
      // fires several triggers in one transaction, so a status transition writes
      // `assets` and `asset_events` with the same `created_at` to the
      // microsecond. Ordering by timestamp alone would leave those two rows
      // arbitrarily ordered between queries and a page boundary landing between
      // them would skip or repeat one. `<` because the order is DESC.
      where.push(
        `(al.created_at, al.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);

    // `cursor_key` is `created_at` re-selected as TEXT, and it must not be
    // derived from the mapped JS `Date`: a Date is millisecond-precision and
    // would truncate a microsecond `timestamptz`, producing a cursor that points
    // slightly EARLIER than the row it came from — which then excludes that row
    // and every row sharing its millisecond. That is Finding 7, and on this table
    // the shared-microsecond case is routine. See `encodeCursor`, whose signature
    // refuses a `Date` for exactly this reason.
    //
    // ORDER BY is DESC on both columns — newest first, which is the only ordering
    // an audit trail is ever read in. The supporting index
    // `audit_log_tenant_id_created_at_idx (tenant_id, created_at, id)` was shipped
    // by 7a with `id` deliberately included (PERF finding 7: a two-column index
    // demotes the row-wise comparison from an Index Cond to a Filter). Postgres
    // scans a btree backwards, so the ascending index serves this descending
    // order — 7b adds no DDL at all.
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT al.id::text AS id,
              al.actor_user_id::text AS actor_user_id,
              al.actor_role::text AS actor_role,
              al.table_name,
              al.row_id::text AS row_id,
              al.action::text AS action,
              al.payload,
              al.created_at,
              al.created_at::text AS cursor_key
         FROM public.audit_log al
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT $${params.length}`,
      ...params,
    );

    const page = toPage(rows, limit, (r) => encodeCursor(String(r.cursor_key), String(r.id)));

    return {
      items: page.items.map(toRow),
      nextCursor: page.nextCursor,
      // The EFFECTIVE limit, so a caller whose oversized request was clamped can
      // see what it actually got.
      limit,
    };
  }
}
