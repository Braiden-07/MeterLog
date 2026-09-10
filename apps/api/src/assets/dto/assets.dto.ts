import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
