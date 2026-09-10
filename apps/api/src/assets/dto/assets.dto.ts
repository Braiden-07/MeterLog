import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../../common/pagination/cursor';

/** Mirrors the `asset_status` enum (PROJECT_BRIEF §5 :136). */
export const ASSET_STATUSES = ['installed', 'active', 'maintenance', 'decommissioned'] as const;

/** Mirrors the `asset_event_type` enum. See ARCHITECTURE §9.2 for what emits each. */
export const ASSET_EVENT_TYPES = [
  'created',
  'installed',
  'activated',
  'maintenance_started',
  'maintenance_completed',
  'decommissioned',
] as const;

/**
 * `?flag=true` arrives as the STRING "true". Without this the value is truthy for
 * any non-empty string, so `?includeDecommissioned=false` would turn the filter
 * ON — a default that fails open. Only the exact string "true" enables it.
 */
const toBoolean = ({ value }: { value: unknown }): boolean => value === 'true' || value === true;

class PaginationQuery {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

export class ListAssetsQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: ASSET_STATUSES })
  @IsOptional()
  @IsIn(ASSET_STATUSES)
  status?: (typeof ASSET_STATUSES)[number];

  @ApiPropertyOptional({ example: 'meter' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  type?: string;

  @ApiPropertyOptional({ description: 'Exact match.', example: 'SN-00042' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  /**
   * Soft-deleted assets are hidden by default (PROJECT_BRIEF §5 :147).
   *
   * The filter is applied in the QUERY BUILDER, never in an RLS policy. A
   * liveness predicate in a policy is the OPEN-5 shape: Postgres applies a SELECT
   * policy to the new row of an `UPDATE ... WHERE`, so `deleted_at IS NULL` in a
   * policy blocks the very UPDATE that performs the soft delete. Isolation is the
   * policy's job; visibility defaults are the application's.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBoolean)
  includeDecommissioned?: boolean;

  @ApiPropertyOptional({ enum: ['createdAt', 'serialNumber'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', 'serialNumber'])
  sort?: 'createdAt' | 'serialNumber';
}

export class ListEventsQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: ASSET_EVENT_TYPES })
  @IsOptional()
  @IsIn(ASSET_EVENT_TYPES)
  eventType?: (typeof ASSET_EVENT_TYPES)[number];
}

export class ListReadingsQuery extends PaginationQuery {
  @ApiPropertyOptional({ description: 'Inclusive lower bound on read_at (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on read_at (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * Registering an asset.
 *
 * **`tenantId` is deliberately absent and must stay absent.** The tenant comes
 * from `app.current_tenant`, which the interceptor set from a re-verified
 * membership. Accepting it from the client would make cross-tenant writes
 * *expressible* — RLS would still refuse them, but the API would be inviting an
 * attempt, and `forbidNonWhitelisted` means sending it is a 400 rather than a
 * silently ignored field.
 *
 * `status` is absent too: a new asset is always `installed` (the column default),
 * and every later status is a TRANSITION, which is phase 3c's `POST /events`.
 */
export class CreateAssetDto {
  @ApiProperty({ example: 'SN-00042' })
  @IsString()
  @MaxLength(120)
  @MinLength(1)
  serialNumber!: string;

  @ApiProperty({ example: 'meter' })
  @IsString()
  @MaxLength(120)
  @MinLength(1)
  type!: string;

  @ApiPropertyOptional({ example: 'Building C, riser 4' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  /**
   * DOMAIN TIME, client-supplied, and deliberately NOT defaulted to `now()`
   * (decision 14). A server timestamp would be a lie about the physical world, and
   * registering today an asset installed last week is ordinary field work. The
   * column is nullable, so "not known" is representable.
   *
   * Distinct from `created_at` (server insertion time) — the same distinction
   * `readings.read_at` carries, and the gap between the two is meaningful data.
   */
  @ApiPropertyOptional({ description: 'When the asset was physically installed (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  installedAt?: string;
}

/**
 * Metadata-only update. **`status` and `deletedAt` are deliberately NOT here.**
 *
 * A status change is a lifecycle TRANSITION — it must emit an event, and the
 * event type depends on where the asset came from, not only where it is going
 * (ARCHITECTURE §9.2). Allowing `PATCH { status }` would create a second
 * status-write path whose event type had to be inferred from the target state,
 * which is the `statusToEventType[newStatus]` trap §9.2 exists to warn about.
 * Transitions go through `POST /assets/:id/events` (phase 3c) and nowhere else.
 *
 * `deletedAt` is absent because decommissioning is a transition too, and because
 * the `assets_decommissioned_iff_deleted` CHECK would reject a `deleted_at` set
 * without its matching status anyway.
 *
 * `serialNumber` is absent: it identifies the physical unit. Correcting a
 * mis-typed serial is a real need, but it interacts with the partial unique index
 * and with re-registration, so it is a deliberate decision rather than a field to
 * add in passing.
 */
export class UpdateAssetDto {
  @ApiPropertyOptional({ example: 'meter' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @MinLength(1)
  type?: string;

  @ApiPropertyOptional({ example: 'Building C, riser 4' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  installedAt?: string;
}

/**
 * Recording a reading. Emits NOTHING — a reading is an observation of an asset,
 * not a change to its lifecycle, so `asset_events` is untouched (asserted).
 */
export class CreateReadingDto {
  /**
   * Sent as a STRING, not a number. `value` is unbounded `numeric` precisely so a
   * cumulative meter total cannot be truncated (see the readings migration), and
   * routing it through a JS `number` would reintroduce exactly that loss at the
   * API boundary — 64-bit float mantissa, ~15-16 significant digits. A decimal
   * string preserves what the column was chosen to preserve.
   */
  @ApiProperty({ example: '10432.75', description: 'Decimal string — not a JSON number.' })
  @IsNumberString({ no_symbols: false })
  @MaxLength(64)
  value!: string;

  @ApiProperty({ example: 'kWh' })
  @IsString()
  @MaxLength(40)
  @MinLength(1)
  unit!: string;

  /** Domain time — when the meter was actually read. Required: a reading with no time is unusable. */
  @ApiProperty({ description: 'When the reading was taken (ISO-8601).' })
  @IsISO8601()
  readAt!: string;
}
