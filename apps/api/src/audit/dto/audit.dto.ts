import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

import {
  AUDIT_ACTIONS,
  AUDIT_DEFAULT_LIMIT,
  AUDITED_TABLES,
  type AuditAction,
  type AuditedTable,
} from '../audit-actions';

/**
 * `rowId` without `tableName` is a MALFORMED QUESTION, not an empty result.
 *
 * Row ids are unique per table by construction, but the trail spans six tables,
 * so "row X, table unspecified" is not a query anyone means. It also cannot use
 * `audit_log_table_name_row_id_idx`, because `row_id` is the index's trailing
 * column — so the naive handling would be a seq scan returning nothing useful.
 *
 * A CLASS-LEVEL constraint because it is a CROSS-FIELD rule: no per-property
 * decorator can see a sibling. That is the whole reason this class exists rather
 * than another `@IsOptional()` on the property.
 *
 * This is the third appearance of the zero-rows-is-not-an-error family (it bit
 * the UPDATE case, and OPEN-9's hard delete inherits it), so ADR-014 pre-decides
 * every shape this endpoint can take: a bad request is a 400, and the only
 * legitimate empty 200 is a well-formed filter that matches nothing.
 */
@ValidatorConstraint({ name: 'rowIdRequiresTableName', async: false })
class RowIdRequiresTableName implements ValidatorConstraintInterface {
  validate(_value: unknown, args?: ValidationArguments): boolean {
    const q = args?.object as ListAuditQuery | undefined;
    if (!q) return true;
    return !(q.rowId !== undefined && q.tableName === undefined);
  }

  defaultMessage(): string {
    return 'rowId requires tableName — a row id is only unique within its table.';
  }
}

export class ListAuditQuery {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  /**
   * NO `@Max` HERE, DELIBERATELY — and this is the one line that makes the clamp
   * possible.
   *
   * `PaginationQuery` (assets, events, readings) carries `@Max(MAX_LIMIT)`, so an
   * oversized limit is a 400 on those endpoints. Adding it here would reject
   * before the service could clamp, and ADR-014 chose clamping: a rejected
   * oversized request leaves the client no forward path, while a clamped one
   * returns rows AND a cursor, so the caller makes progress and learns the cap
   * from `limit` in the response envelope.
   *
   * `@Min(1)` and `@IsInt()` still hold, so `limit=0`, `limit=-5` and `limit=abc`
   * are 400s for free — the clamp applies only to the one case where a forward
   * path exists.
   */
  @ApiPropertyOptional({ minimum: 1, default: AUDIT_DEFAULT_LIMIT, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;

  /**
   * A CLOSED enum, so an unknown action is a 400 rather than a 200 matching
   * nothing. The list is imported from `audit-actions.ts` — the single source
   * mirrored from ADR-012 — never restated here.
   */
  @ApiPropertyOptional({ enum: AUDIT_ACTIONS })
  @IsOptional()
  @IsIn(AUDIT_ACTIONS as readonly string[])
  action?: AuditAction;

  /** Drill-down, half one: the audited table. Closed set (ADR-012's six). */
  @ApiPropertyOptional({ enum: AUDITED_TABLES })
  @IsOptional()
  @IsIn(AUDITED_TABLES as readonly string[])
  tableName?: AuditedTable;

  /** Drill-down, half two. Requires `tableName` — see the constraint above. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  @Validate(RowIdRequiresTableName)
  rowId?: string;

  /**
   * "What has this person done." Served by the PARTIAL index
   * `audit_log_actor_user_id_idx (WHERE actor_user_id IS NOT NULL)`, which is
   * exactly right: a NULL actor is a pre-authentication bootstrap row (ADR-013)
   * and those are invisible to every application read anyway.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  actorUserId?: string;

  /**
   * HALF-OPEN range `[from, to)` on `created_at`, served by the range predicate
   * on `audit_log_tenant_id_created_at_idx`.
   *
   * Half-open rather than inclusive-both-ends because consecutive windows must
   * tile without overlapping: with an inclusive `to`, a row landing exactly on a
   * boundary appears in BOTH the window that ends there and the one that starts
   * there — double-counted in any report built by walking days. The same class of
   * off-by-one the keyset cursor exists to avoid, one level up.
   */
  @ApiPropertyOptional({ description: 'Inclusive lower bound, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'EXCLUSIVE upper bound, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * One audit row as the API returns it.
 *
 * THE PAYLOAD IS RETURNED VERBATIM AND IS NOT RE-REDACTED. ADR-011 makes the
 * trigger the SOLE redactor, enforced by a per-table column allowlist that lives
 * in `pg_trigger.tgargs` and is asserted structurally by catalog assertion 17.
 * The stored rows are safe by construction, so the read is safe because they are.
 *
 * A second redaction pass here was considered and rejected (ADR-014): it would
 * imply the stored rows are untrusted, contradicting ADR-011, and would create a
 * worse failure mode where the read filter quietly compensates for a broken
 * allowlist — so the allowlist could regress with every test still green. That is
 * the redundant-predicate trap the tenant filter avoids, applied to secrets.
 */
export class AuditRow {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  /**
   * NULLABLE, and the null cases are the point (ADR-009, ADR-013).
   *
   * A NULL actor means a pre-authentication bootstrap action — `register_tenant`
   * runs before anyone is authenticated, so there is no actor BY CONSTRUCTION.
   * Those rows also carry a NULL tenant and are therefore invisible to this
   * endpoint entirely, so in practice a row returned here has an actor unless a
   * future pre-auth path changes that.
   */
  @ApiProperty({ format: 'uuid', nullable: true })
  actorUserId!: string | null;

  /**
   * ROLE AT THE TIME OF THE ACTION — the visible payoff of OPEN-4 and ADR-009,
   * and the one field on this row that NO OTHER TABLE CAN RECONSTRUCT.
   *
   * Joining to `memberships` at read time returns today's answer, or none at all
   * once the membership is revoked. The snapshot is what lets the trail answer
   * "who did this, and what were they allowed to do at the time" — which is the
   * question an audit trail exists for. Omitting it would make the auditor view
   * decorative.
   */
  @ApiProperty({ enum: ['admin', 'technician', 'auditor'], nullable: true })
  actorRole!: string | null;

  /** The audited table. Named `table_name` in the schema — ADR-015. */
  @ApiProperty({ enum: AUDITED_TABLES })
  tableName!: string;

  @ApiProperty({ format: 'uuid' })
  rowId!: string;

  @ApiProperty({ enum: AUDIT_ACTIONS })
  action!: string;

  /** `{ before, after }`. `before` is null for an INSERT. Already redacted. */
  @ApiProperty({ type: 'object', additionalProperties: true })
  payload!: unknown;

  @ApiProperty()
  createdAt!: Date;
}

/**
 * The page envelope.
 *
 * `limit` IS THE EFFECTIVE LIMIT, NOT THE REQUESTED ONE, and it is in the
 * response for a reason rather than for symmetry: an oversized request is
 * silently clamped (ADR-014), so without this field the caller cannot tell
 * "clamped to 200" from "there were only 200 rows left". It is also how the
 * clamp is tested — the assertion has nothing else to read.
 */
export class AuditPage {
  @ApiProperty({ type: [AuditRow] })
  items!: AuditRow[];

  @ApiProperty({ nullable: true, description: 'Null when there are no further rows.' })
  nextCursor!: string | null;

  @ApiProperty({ description: 'The limit actually applied, after clamping.' })
  limit!: number;
}

/** Thrown by the service when `from`/`to` are ordered impossibly. */
export function invalidRange(): BadRequestException {
  return new BadRequestException({
    error: { code: 'INVALID_RANGE', message: '`from` must be earlier than `to`.' },
  });
}
