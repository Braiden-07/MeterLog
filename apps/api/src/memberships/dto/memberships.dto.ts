import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, MaxLength } from 'class-validator';

/**
 * The roles a membership may carry (ADR-006 §2). Mirrors the `membership_role`
 * enum; an unknown value is rejected at the boundary rather than reaching the
 * database, where it would surface as a cast error rather than a 400.
 */
export const MEMBERSHIP_ROLES = ['admin', 'technician', 'auditor'] as const;

export class InviteMemberDto {
  @ApiProperty({ example: 'tech@acme.test' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ enum: MEMBERSHIP_ROLES, example: 'technician' })
  @IsIn(MEMBERSHIP_ROLES)
  role!: (typeof MEMBERSHIP_ROLES)[number];
}

export class ChangeMemberRoleDto {
  @ApiProperty({ enum: MEMBERSHIP_ROLES, example: 'auditor' })
  @IsIn(MEMBERSHIP_ROLES)
  role!: (typeof MEMBERSHIP_ROLES)[number];
}
