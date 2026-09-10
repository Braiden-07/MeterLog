import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import {
  DEFAULT_LIMIT,
  type Page,
  decodeCursor,
  encodeCursor,
  toPage,
} from '../common/pagination/cursor';
import { requireRequestContext } from '../common/request-context/request-context';
import type {
  CreateAssetDto,
  CreateReadingDto,
  ListAssetsQuery,
  ListEventsQuery,
  ListReadingsQuery,
  UpdateAssetDto,
} from './dto/assets.dto';

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

/**
 * A raw row as Postgres returns it: snake_case, plus `cursor_key` — the sort column
 * re-selected as text so the cursor round-trips without losing microseconds.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw rows are untyped by Prisma. */
type RawRow = Record<string, any>;

/**
 * Pages raw rows, builds the cursor from `cursor_key`, then maps to the DTO shape.
 *
 * The cursor is built from the RAW row deliberately: deriving it from the mapped
 * object would mean reading a JS `Date` and truncating microseconds, which is the
 * bug documented in `encodeCursor`.
 */
/**
 * An `INSERT ... RETURNING` always yields a row, but the type system cannot know
 * that. Throwing beats `!`: if the invariant ever breaks the failure is loud and
 * named, rather than a `TypeError` on an undefined property three frames away.
 */
function firstRow(rows: RawRow[], what: string): RawRow {
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

function mapPage<T>(rows: RawRow[], limit: number, map: (r: RawRow) => T): Page<T> {
  const paged = toPage(rows, limit, (r) => encodeCursor(String(r.cursor_key), String(r.id)));
  return { items: paged.items.map(map), nextCursor: paged.nextCursor };
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
      // The cursor key is text; cast it back to the column's own type so the
      // comparison is exact rather than lexicographic.
      const cast = column === 'created_at' ? '::timestamptz' : '::text';
      where.push(
        `(a.${column}, a.id) ${op} ($${params.length - 1}${cast}, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);
    // `cursor_key` is the sort column re-selected as TEXT. It must not be derived
    // from the mapped `Date`: a JS Date is millisecond-precision and would truncate
    // a microsecond timestamptz, breaking the next page. See encodeCursor.
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT a.id::text AS id, a.serial_number, a.type, a.status::text AS status,
              a.location, a.installed_at, a.created_at, a.updated_at, a.deleted_at,
              a.${column}::text AS cursor_key
         FROM public.assets a
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.${column} ${direction}, a.id ${direction}
        LIMIT $${params.length}`,
      ...params,
    );

    return mapPage(rows, limit, toAsset);
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
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
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
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT e.id::text AS id, e.asset_id::text AS asset_id, e.event_type::text AS event_type,
              e.payload, e.created_by::text AS created_by, e.created_at,
              e.created_at::text AS cursor_key
         FROM public.asset_events e
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${params.length}`,
      ...params,
    );

    return mapPage(rows, limit, toEvent);
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
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `SELECT r.id::text AS id, r.asset_id::text AS asset_id, r.value::text AS value,
              r.unit, r.read_at, r.created_by::text AS created_by, r.created_at,
              r.read_at::text AS cursor_key
         FROM public.readings r
        WHERE ${where.join(' AND ')}
        ORDER BY r.read_at DESC, r.id DESC
        LIMIT $${params.length}`,
      ...params,
    );

    return mapPage(rows, limit, toReading);
  }

  /**
   * Registers an asset. **Writes THREE rows in ONE transaction**: the asset, then
   * its `created` and `installed` events.
   *
   * ATOMICITY COMES FOR FREE, AND THAT IS THE WHOLE DESIGN (decision 3). The
   * interceptor already opened an interactive transaction to issue `SET LOCAL`,
   * and `requireRequestContext().tx` is that transaction — so these three
   * statements are in it by construction. No new machinery, no `SECURITY DEFINER`
   * (there is no privilege gap: the app role holds `INSERT` on both tables), and
   * no trigger.
   *
   * THE TRIGGER WAS REJECTED FOR A CONCRETE REPO REASON, recorded here because it
   * is the obvious "make emission unbypassable" suggestion: a trigger needs
   * `created_by`, which is `NOT NULL`, and would have to read it from
   * `app.current_user`. Every migrator-seeded fixture — `seedIsolationContext`,
   * the PERF harness, every db suite — inserts assets with no such GUC set, so the
   * trigger would need a "skip when unset" fallback. That fallback IS the silent
   * skip the trigger existed to prevent, only now fail-open by default.
   *
   * WHAT GUARDS EMISSION INSTEAD: emission lives at this single choke point (there
   * is no other code path that inserts into `assets`), the §9.2 invariant is
   * asserted by test, and 3c routes every transition through one `applyTransition`
   * method for the same reason.
   *
   * `tenant_id` comes from `app.current_tenant` via the RLS policy's `WITH CHECK`,
   * not from the client — `CreateAssetDto` has no `tenantId` field, so a
   * cross-tenant write is not expressible at the API boundary at all.
   */
  async create(dto: CreateAssetDto): Promise<Asset> {
    const { tx, userId } = requireRequestContext();

    // The policy's WITH CHECK requires tenant_id to equal the GUC, so it is read
    // from the GUC rather than passed in. Writing it any other way would either be
    // refused by the policy or — worse — be a value the API let a client choose.
    const inserted = await tx
      .$queryRawUnsafe<RawRow[]>(
        `INSERT INTO public.assets (tenant_id, serial_number, type, location, installed_at)
       VALUES (NULLIF(current_setting('app.current_tenant', true), '')::uuid,
               $1, $2, $3, $4::timestamptz)
       RETURNING id::text AS id, serial_number, type, status::text AS status,
                 location, installed_at, created_at, updated_at, deleted_at`,
        dto.serialNumber,
        dto.type,
        dto.location ?? null,
        dto.installedAt ?? null,
      )
      .catch(rethrowDuplicateSerial);

    const asset = toAsset(firstRow(inserted, 'assets INSERT ... RETURNING'));

    // THE GENESIS PAIR (ARCHITECTURE §9.2). BOTH events, not just `created`.
    //
    // The invariant: every status an asset has ever held must have an event that
    // put it there. A new asset is `installed`, so emitting only `created` would
    // leave its first status unexplained and make the log unreplayable — and
    // replaying the log to reconstruct status at a past time is the entire reason
    // to keep an append-only lifecycle log instead of just reading `status`.
    //
    // Both rows are inserted in ONE statement so they share a `created_at` to the
    // microsecond. That shared timestamp is the observable evidence of the single
    // transaction, and it is also why every events cursor carries `id` as a
    // tiebreaker (cursor.ts) — this is the guaranteed tie.
    await tx.$executeRawUnsafe(
      `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, payload, created_by)
       VALUES (NULLIF(current_setting('app.current_tenant', true), '')::uuid,
               $1::uuid, 'created', '{}'::jsonb, $2::uuid),
              (NULLIF(current_setting('app.current_tenant', true), '')::uuid,
               $1::uuid, 'installed', $3::jsonb, $2::uuid)`,
      asset.id,
      userId,
      JSON.stringify({ from: null, to: 'installed' }),
    );

    return asset;
  }

  /**
   * Metadata-only update. **Emits nothing, by design.**
   *
   * Correcting a typo in `location` is not a lifecycle event — it is exactly the
   * §9.2 case that distinguishes `asset_events` from `audit_log`: this mutation
   * will belong in the audit log (step 7) and must NOT appear in the lifecycle
   * log, because nothing happened to the physical asset.
   *
   * `status` and `deletedAt` cannot arrive here: they are absent from
   * `UpdateAssetDto`, so `forbidNonWhitelisted` rejects them with a 400. Note
   * carefully that the pipe is not the guard — it only refuses fields the DTO does
   * not declare, and would happily accept `status` the moment someone added it.
   * **The DTO shape is the guard**, and the test asserting the 400 is what pins it.
   */
  async update(id: string, dto: UpdateAssetDto): Promise<Asset> {
    const { tx } = requireRequestContext();
    await this.findOne(id);

    const sets: string[] = [];
    const params: unknown[] = [];

    if (dto.type !== undefined) {
      params.push(dto.type);
      sets.push(`type = $${params.length}`);
    }
    if (dto.location !== undefined) {
      params.push(dto.location);
      sets.push(`location = $${params.length}`);
    }
    if (dto.installedAt !== undefined) {
      params.push(dto.installedAt);
      sets.push(`installed_at = $${params.length}::timestamptz`);
    }

    if (sets.length === 0) return this.findOne(id);

    sets.push('updated_at = now()');
    params.push(id);

    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `UPDATE public.assets SET ${sets.join(', ')}
        WHERE id = $${params.length}::uuid
       RETURNING id::text AS id, serial_number, type, status::text AS status,
                 location, installed_at, created_at, updated_at, deleted_at`,
      ...params,
    );

    // RLS makes another tenant's row invisible, so zero rows here means the same
    // thing findOne's zero rows means. Re-checked rather than assumed: a silent
    // no-op returning 200 would be worse than a 404.
    const row = rows[0];
    if (!row) throw assetNotFound();
    return toAsset(row);
  }

  /**
   * Records a reading. **Emits no event**, asserted by test.
   *
   * A reading is an OBSERVATION of an asset, not a change to its lifecycle. The
   * asset's status is unaffected, so there is nothing for the lifecycle log to
   * record and writing one would corrupt a replay.
   */
  async createReading(assetId: string, dto: CreateReadingDto): Promise<Reading> {
    const { tx, userId } = requireRequestContext();
    await this.findOne(assetId);

    // asset_id and tenant_id must agree (ADR-007's composite FK). tenant_id comes
    // from the GUC and asset_id has just been confirmed visible under that same
    // GUC, so the pair agrees by construction; the FK is the floor under that
    // reasoning rather than a thing this code has to get right.
    const rows = await tx.$queryRawUnsafe<RawRow[]>(
      `INSERT INTO public.readings (tenant_id, asset_id, value, unit, read_at, created_by)
       VALUES (NULLIF(current_setting('app.current_tenant', true), '')::uuid,
               $1::uuid, $2::numeric, $3, $4::timestamptz, $5::uuid)
       RETURNING id::text AS id, asset_id::text AS asset_id, value::text AS value,
                 unit, read_at, created_by::text AS created_by, created_at`,
      assetId,
      dto.value,
      dto.unit,
      dto.readAt,
      userId,
    );

    return toReading(firstRow(rows, 'readings INSERT ... RETURNING'));
  }
}

/**
 * The partial unique index refuses a duplicate live serial within a tenant
 * (`assets_tenant_serial_live_key`). Mapped to 409 rather than surfacing as a 500.
 *
 * Matched on the SQLSTATE, never the message: Prisma normalises unique violations
 * and DISCARDS the constraint name (measured at the phase 1 close-out — the app
 * role sees `Unique constraint failed: ` with an empty target), so a mapping keyed
 * on the index name would never fire. `assets` has exactly one other unique index,
 * `(id, tenant_id)`, whose columns are server-generated, so 23505 on this INSERT
 * can only be the serial.
 */
function rethrowDuplicateSerial(error: unknown): never {
  const code = (error as { meta?: { code?: unknown } }).meta?.code;
  if (code === '23505') {
    throw new ConflictException({
      error: {
        code: 'ASSET_SERIAL_EXISTS',
        message: 'An active asset with that serial number already exists in this workspace.',
      },
    });
  }
  throw error;
}

function assetNotFound(): NotFoundException {
  return new NotFoundException({
    error: { code: 'ASSET_NOT_FOUND', message: 'No such asset in this workspace.' },
  });
}

function toAsset(r: RawRow): Asset {
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

function toEvent(r: RawRow): AssetEvent {
  return {
    id: r.id,
    assetId: r.asset_id,
    eventType: r.event_type,
    payload: r.payload,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toReading(r: RawRow): Reading {
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
