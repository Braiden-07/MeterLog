import { Injectable, NotFoundException } from '@nestjs/common';

import {
  DEFAULT_LIMIT,
  type Page,
  decodeCursor,
  encodeCursor,
  toPage,
} from '../common/pagination/cursor';
import { requireRequestContext } from '../common/request-context/request-context';
import type { ListAssetsQuery, ListEventsQuery, ListReadingsQuery } from './dto/assets.dto';

export interface Asset {
  id: string;
  serialNumber: string;
  type: string;
  status: string;
  location: string | null;
  installedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AssetEvent {
  id: string;
  assetId: string;
  eventType: string;
  payload: unknown;
  createdBy: string;
  createdAt: Date;
}

export interface Reading {
  id: string;
  assetId: string;
  value: string;
  unit: string;
  readAt: Date;
  createdBy: string;
  createdAt: Date;
}

/** Sort columns, mapped from API names to real columns. */
const ASSET_SORT = {
  createdAt: { column: 'created_at', direction: 'DESC' },
  serialNumber: { column: 'serial_number', direction: 'ASC' },
} as const;

/**
 * The read surface for assets and their children (step 6 phase 3a).
 *
 * **There is no `tenant_id` in any WHERE clause here, and there must not be.**
 * Every query runs on the request transaction, where the interceptor has set
 * `app.current_tenant`, so the tenant policies scope the results. Adding an
 * application-layer tenant predicate would not make isolation stronger — it would
 * make a policy regression invisible, because the redundant filter would keep
 * returning correct results after the thing that actually protects the data
 * stopped working. Same rule as `MembershipsService.list`.
 *
 * Queries are raw SQL rather than the Prisma query builder, matching the existing
 * services, because keyset pagination needs a row-wise comparison
 * (`(sort_col, id) < (?, ?)`) that the query builder cannot express.
 */
@Injectable()
export class AssetsService {
  async list(query: ListAssetsQuery): Promise<Page<Asset>> {
    const { tx } = requireRequestContext();
    const limit = query.limit ?? DEFAULT_LIMIT;
    const { column, direction } = ASSET_SORT[query.sort ?? 'createdAt'];

    const where: string[] = [];
    const params: unknown[] = [];

    // Soft-delete default lives HERE, in the query builder — never in a policy
    // (OPEN-5). See the DTO comment for why.
    if (!query.includeDecommissioned) where.push('a.deleted_at IS NULL');

    if (query.status) {
      params.push(query.status);
      where.push(`a.status = $${params.length}::public.asset_status`);
    }
    if (query.type) {
      params.push(query.type);
      where.push(`a.type = $${params.length}`);
    }
    if (query.serialNumber) {
      params.push(query.serialNumber);
      where.push(`a.serial_number = $${params.length}`);
    }

    if (query.cursor) {
      const { k, i } = decodeCursor(query.cursor);
      params.push(k, i);
      // The row-wise comparison IS the keyset. `id` is in the tuple because the
      // sort column is not unique; see cursor.ts.
      const op = direction === 'DESC' ? '<' : '>';
      const cast = column === 'created_at' ? '::timestamptz' : '';
      where.push(
        `(a.${column}, a.id) ${op} ($${params.length - 1}${cast}, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);
    const rows = await tx.$queryRawUnsafe<Record<string, never>[]>(
      `SELECT a.id::text AS id, a.serial_number, a.type, a.status::text AS status,
              a.location, a.installed_at, a.created_at, a.updated_at, a.deleted_at
         FROM public.assets a
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.${column} ${direction}, a.id ${direction}
        LIMIT $${params.length}`,
      ...params,
    );

    const assets = rows.map(toAsset);
    return toPage(assets, limit, (a) =>
      encodeCursor(column === 'created_at' ? a.createdAt : a.serialNumber, a.id),
    );
  }

  /**
   * One asset, including a decommissioned one.
   *
   * **The soft-delete filter is a LIST-SCOPE DEFAULT, never an existence check.**
   * A decommissioned asset still exists, its history is still auditable, and its
   * URL must keep working — that is the whole point of soft delete over a real
   * one. Filtering it here would make `GET /assets/:id` 404 for a row the list
   * endpoint can return with one query parameter, which is incoherent.
   *
   * A 404 therefore means exactly one thing: no such row is visible under the
   * active tenant's policy. Whether the asset does not exist at all or belongs to
   * another tenant is deliberately indistinguishable — the same anti-enumeration
   * shape as `MB002` (ADR-006 §7). RLS produces it for free: another tenant's
   * asset simply is not in the result set.
   */
  async findOne(id: string): Promise<Asset> {
    const { tx } = requireRequestContext();
    const rows = await tx.$queryRawUnsafe<Record<string, never>[]>(
      `SELECT a.id::text AS id, a.serial_number, a.type, a.status::text AS status,
              a.location, a.installed_at, a.created_at, a.updated_at, a.deleted_at
         FROM public.assets a
        WHERE a.id = $1::uuid`,
      id,
    );
    const row = rows[0];
    if (!row) throw assetNotFound();
    return toAsset(row);
  }

  async listEvents(assetId: string, query: ListEventsQuery): Promise<Page<AssetEvent>> {
    const { tx } = requireRequestContext();
    // Existence is resolved first so a missing or other-tenant asset 404s rather
    // than returning an empty page, which would be indistinguishable from an
    // asset that genuinely has no events.
    await this.findOne(assetId);

    const limit = query.limit ?? DEFAULT_LIMIT;
    const where = ['e.asset_id = $1::uuid'];
    const params: unknown[] = [assetId];

    if (query.eventType) {
      params.push(query.eventType);
      where.push(`e.event_type = $${params.length}::public.asset_event_type`);
    }
    if (query.cursor) {
      const { k, i } = decodeCursor(query.cursor);
      params.push(k, i);
      where.push(
        `(e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);
    const rows = await tx.$queryRawUnsafe<Record<string, never>[]>(
      `SELECT e.id::text AS id, e.asset_id::text AS asset_id, e.event_type::text AS event_type,
              e.payload, e.created_by::text AS created_by, e.created_at
         FROM public.asset_events e
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${params.length}`,
      ...params,
    );

    const events = rows.map(toEvent);
    return toPage(events, limit, (e) => encodeCursor(e.createdAt, e.id));
  }

  async listReadings(assetId: string, query: ListReadingsQuery): Promise<Page<Reading>> {
    const { tx } = requireRequestContext();
    await this.findOne(assetId);

    const limit = query.limit ?? DEFAULT_LIMIT;
    const where = ['r.asset_id = $1::uuid'];
    const params: unknown[] = [assetId];

    if (query.from) {
      params.push(query.from);
      where.push(`r.read_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`r.read_at <= $${params.length}::timestamptz`);
    }
    if (query.cursor) {
      const { k, i } = decodeCursor(query.cursor);
      params.push(k, i);
      where.push(
        `(r.read_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);
    const rows = await tx.$queryRawUnsafe<Record<string, never>[]>(
      `SELECT r.id::text AS id, r.asset_id::text AS asset_id, r.value::text AS value,
              r.unit, r.read_at, r.created_by::text AS created_by, r.created_at
         FROM public.readings r
        WHERE ${where.join(' AND ')}
        ORDER BY r.read_at DESC, r.id DESC
        LIMIT $${params.length}`,
      ...params,
    );

    const readings = rows.map(toReading);
    return toPage(readings, limit, (r) => encodeCursor(r.readAt, r.id));
  }
}

function assetNotFound(): NotFoundException {
  return new NotFoundException({
    error: { code: 'ASSET_NOT_FOUND', message: 'No such asset in this workspace.' },
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- raw rows are snake_case and untyped by Prisma. */
function toAsset(r: any): Asset {
  return {
    id: r.id,
    serialNumber: r.serial_number,
    type: r.type,
    status: r.status,
    location: r.location,
    installedAt: r.installed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function toEvent(r: any): AssetEvent {
  return {
    id: r.id,
    assetId: r.asset_id,
    eventType: r.event_type,
    payload: r.payload,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toReading(r: any): Reading {
  return {
    id: r.id,
    assetId: r.asset_id,
    // `numeric` is returned as a Prisma Decimal; serialised as a STRING so a
    // cumulative meter total cannot lose precision through a JS float, which the
    // migration's "unbounded numeric" decision exists to prevent.
    value: String(r.value),
    unit: r.unit,
    readAt: r.read_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
