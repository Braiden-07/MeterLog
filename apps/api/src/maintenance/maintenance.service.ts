import { Injectable, NotFoundException } from '@nestjs/common';

import {
  DEFAULT_LIMIT,
  type Page,
  decodeCursor,
  encodeCursor,
  toPage,
} from '../common/pagination/cursor';
import { requireRequestContext } from '../common/request-context/request-context';
import type {
  CreateMaintenanceRecordDto,
  ListMaintenanceQuery,
  UpdateMaintenanceRecordDto,
} from './dto/maintenance.dto';

export interface MaintenanceRecord {
  id: string;
  assetId: string;
  description: string;
  performedAt: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const SORT = {
  performedAt: 'performed_at',
  createdAt: 'created_at',
} as const;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw rows are untyped by Prisma. */
type RawRow = Record<string, any>;

const COLUMNS = `m.id::text AS id, m.asset_id::text AS asset_id, m.description,
                 m.performed_at, m.created_by::text AS created_by,
                 m.created_at, m.updated_at, m.deleted_at`;

/**
 * `maintenance_records` — the fourth v1.0 domain child, and the only **mutable**
 * one (ADR-008).
 *
 * **No `tenant_id` appears in any WHERE clause, and there must not be one.** Every
 * query runs on the request transaction where the interceptor set
 * `app.current_tenant`, so the policy scopes the results. A redundant app-layer
 * tenant predicate would keep returning correct results after the thing that
 * actually protects the data stopped working. Same rule as the assets service.
 *
 * **Soft delete only.** The app role holds no `DELETE` privilege, so `remove()` is
 * an `UPDATE` writing `deleted_at`. Liveness filtering is done HERE, in the query
 * builder — never in the policy, which is the OPEN-5 deadlock.
 */
@Injectable()
export class MaintenanceService {
  async list(query: ListMaintenanceQuery): Promise<Page<MaintenanceRecord>> {
    const { tx } = requireRequestContext();
    const limit = query.limit ?? DEFAULT_LIMIT;
    const column = SORT[query.sort ?? 'performedAt'];

    const where: string[] = [];
    const params: unknown[] = [];

    // Soft-delete default — in the query builder, never in the policy (OPEN-5).
    if (!query.includeDeleted) where.push('m.deleted_at IS NULL');

    if (query.assetId) {
      params.push(query.assetId);
      where.push(`m.asset_id = $${params.length}::uuid`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`m.performed_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`m.performed_at <= $${params.length}::timestamptz`);
    }

    if (query.cursor) {
      const { k, i } = decodeCursor(query.cursor);
      params.push(k, i);
      // FINDING 7 APPLIED FROM DAY ONE. The cursor key is the sort column's raw
      // TEXT, never a JS Date: a Date is millisecond-precision and would truncate a
      // microsecond timestamptz, making the cursor point earlier than its own row
      // and silently skipping every row that shares its millisecond. `id` is in the
      // tuple because `performed_at` is not unique.
      where.push(
        `(m.${column}, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT ${COLUMNS}, m.${column}::text AS cursor_key
         FROM public.maintenance_records m
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.${column} DESC, m.id DESC
        LIMIT $${params.length}`,
      ...params,
    );

    const paged = toPage(rows, limit, (r) => encodeCursor(String(r.cursor_key), String(r.id)));
    return { items: paged.items.map(toRecord), nextCursor: paged.nextCursor };
  }

  /**
   * One record. A soft-deleted record is still returned — the liveness filter is a
   * LIST-SCOPE default, not an existence check, exactly as on `assets`. Filtering
   * it here would 404 a row the list endpoint returns with one query parameter.
   *
   * A 404 means one thing: no such row is visible under the active tenant's policy.
   * Whether it does not exist or belongs to another tenant is deliberately
   * indistinguishable (the `MB002` anti-enumeration shape, ADR-006 §7).
   */
  async findOne(id: string): Promise<MaintenanceRecord> {
    const { tx } = requireRequestContext();
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT ${COLUMNS} FROM public.maintenance_records m WHERE m.id = $1::uuid`,
      id,
    );
    const row = rows[0];
    if (!row) throw notFound();
    return toRecord(row);
  }

  /**
   * Creates a record. `tenant_id` comes from the GUC, never the client.
   *
   * The asset is resolved under the caller's own context FIRST, so an `assetId`
   * belonging to another tenant is a clean **404** rather than a `23503` surfacing
   * as a 500 — and the ADR-007 composite FK remains the floor underneath that,
   * since both halves then come from the same verified universe.
   */
  async create(dto: CreateMaintenanceRecordDto): Promise<MaintenanceRecord> {
    const { tx, userId } = requireRequestContext();

    const asset = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT id FROM public.assets WHERE id = $1::uuid`,
      dto.assetId,
    );
    if (!asset[0]) throw assetNotFound();

    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `INSERT INTO public.maintenance_records
         (tenant_id, asset_id, description, performed_at, created_by)
       VALUES (NULLIF(current_setting('app.current_tenant', true), '')::uuid,
               $1::uuid, $2, $3::timestamptz, $4::uuid)
       RETURNING ${COLUMNS.replace(/m\./g, '')}`,
      dto.assetId,
      dto.description,
      dto.performedAt,
      userId,
    );

    const created = rows[0];
    // An INSERT ... RETURNING always yields a row; throwing beats `!` so a broken
    // invariant fails loudly and named rather than as a TypeError downstream.
    if (!created) throw new Error('maintenance_records INSERT ... RETURNING returned no row');
    return toRecord(created);
  }

  /**
   * **The first general field edit in the domain.** On `assets`, `PATCH` edits
   * metadata and `status` is a state transition that must emit an event; there is no
   * general field edit. Here there is, and nothing is emitted — correcting a
   * description is not a lifecycle event, and §9.2's distinction applies: this
   * mutation belongs in `audit_log` (step 7, OPEN-6) and **not** in `asset_events`.
   *
   * `tenant_id` and `asset_id` are not updatable: absent from the DTO, and
   * `tenant_id` additionally pinned by the policy's `WITH CHECK`, which is what
   * makes moving a row between tenants impossible rather than merely unsupported.
   */
  async update(id: string, dto: UpdateMaintenanceRecordDto): Promise<MaintenanceRecord> {
    const { tx } = requireRequestContext();
    await this.findOne(id);

    const sets: string[] = [];
    const params: unknown[] = [];

    if (dto.description !== undefined) {
      params.push(dto.description);
      sets.push(`description = $${params.length}`);
    }
    if (dto.performedAt !== undefined) {
      params.push(dto.performedAt);
      sets.push(`performed_at = $${params.length}::timestamptz`);
    }

    if (sets.length === 0) return this.findOne(id);

    sets.push('updated_at = now()');
    params.push(id);

    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `UPDATE public.maintenance_records SET ${sets.join(', ')}
        WHERE id = $${params.length}::uuid
       RETURNING ${COLUMNS.replace(/m\./g, '')}`,
      ...params,
    );

    const row = rows[0];
    if (!row) throw notFound();
    return toRecord(row);
  }

  /**
   * **Soft delete — an `UPDATE`, because the app role holds no `DELETE` privilege
   * (ADR-008).** Returns 204; the row persists and disappears from the default list.
   *
   * This is where the OPEN-5 resolution pays off: the policy carries no `deleted_at`
   * predicate, so this statement can see the row it is writing. A liveness predicate
   * in the policy would make Postgres apply it to the NEW row of the `UPDATE` and the
   * statement would match nothing — the deadlock recorded on `memberships`.
   *
   * Already-deleted is idempotent rather than a 409: unlike decommissioning an asset
   * (a lifecycle transition with an event, where a second one would corrupt the log),
   * this writes no event and has no state machine. Re-deleting refreshes a timestamp
   * and changes nothing observable.
   */
  async remove(id: string): Promise<void> {
    const { tx } = requireRequestContext();
    await this.findOne(id);

    await tx.$executeRawUnsafe(
      `UPDATE public.maintenance_records SET deleted_at = now(), updated_at = now()
        WHERE id = $1::uuid AND deleted_at IS NULL`,
      id,
    );
  }
}

function notFound(): NotFoundException {
  return new NotFoundException({
    error: {
      code: 'MAINTENANCE_RECORD_NOT_FOUND',
      message: 'No such maintenance record in this workspace.',
    },
  });
}

function assetNotFound(): NotFoundException {
  return new NotFoundException({
    error: { code: 'ASSET_NOT_FOUND', message: 'No such asset in this workspace.' },
  });
}

function toRecord(r: RawRow): MaintenanceRecord {
  return {
    id: r.id,
    assetId: r.asset_id,
    description: r.description,
    performedAt: r.performed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}
