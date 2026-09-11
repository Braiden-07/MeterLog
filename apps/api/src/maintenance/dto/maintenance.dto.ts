import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../../common/pagination/cursor';

/** `?flag=true` arrives as the STRING "true"; only that exact value enables it. */
const toBoolean = ({ value }: { value: unknown }): boolean => value === 'true' || value === true;

export class ListMaintenanceQuery {
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

  @ApiPropertyOptional({ description: 'Only records for this asset.' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on performed_at (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on performed_at (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  /**
   * Soft-deleted records are hidden by default (ADR-008).
   *
   * The filter lives in the QUERY BUILDER, never in the RLS policy. A liveness
   * predicate in a SELECT-applicable policy blocks the very UPDATE that performs
   * the soft delete — the OPEN-5 deadlock. Isolation is the policy's job;
   * visibility defaults are the application's.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBoolean)
  includeDeleted?: boolean;

  @ApiPropertyOptional({ enum: ['performedAt', 'createdAt'], default: 'performedAt' })
  @IsOptional()
  @IsIn(['performedAt', 'createdAt'])
  sort?: 'performedAt' | 'createdAt';
}

/**
 * Creating a maintenance record.
 *
 * **`tenantId` is absent and must stay absent** — the tenant comes from
 * `app.current_tenant`, so a cross-tenant write is not expressible at the API
 * boundary and `forbidNonWhitelisted` makes the attempt a 400 rather than a field
 * RLS then quietly refuses.
 */
export class CreateMaintenanceRecordDto {
  @ApiProperty({ description: 'The asset the work was performed on.' })
  @IsUUID()
  assetId!: string;

  @ApiProperty({ example: 'Replaced register dial; calibration verified.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  /** Domain time — when the work was done. Caller-supplied, no default. */
  @ApiProperty({ description: 'When the work was performed (ISO-8601).' })
  @IsISO8601()
  performedAt!: string;
}

/**
 * Editing a maintenance record — **the first general field edit in the domain.**
 *
 * `assetId` is deliberately absent: a maintenance record is **not reparentable**
 * (ADR-008). It documents work done on one physical asset, and moving it would
 * rewrite two histories at once. A mis-filed record is soft-deleted and re-created.
 *
 * `tenantId` and `deletedAt` are absent for the same reason they are absent from
 * `UpdateAssetDto`: the tenant is never client-supplied, and deletion is an
 * operation (`DELETE /maintenance-records/:id`), not a field.
 *
 * As with `UpdateAssetDto`, **the DTO shape is the guard, not `forbidNonWhitelisted`**
 * — the pipe only refuses fields the DTO does not declare, and would happily accept
 * `assetId` the moment someone added it. The tests asserting these 400s are what pin
 * the absence.
 */
export class UpdateMaintenanceRecordDto {
  @ApiPropertyOptional({ example: 'Replaced register dial; calibration verified.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'When the work was performed (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  performedAt?: string;
}
