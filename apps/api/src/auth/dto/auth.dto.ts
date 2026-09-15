import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'Acme Metering' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  tenantName!: string;

  @ApiProperty({ example: 'founder@acme.test' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  // Length only. Composition rules push users toward predictable passwords and
  // are not what makes a credential strong; argon2 (ADR-001) does the work.
  @ApiProperty({ example: 'correct horse battery staple', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'founder@acme.test' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  password!: string;
}

export class SwitchTenantDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  tenantId!: string;
}

/**
 * Redeeming an invite token (OPEN-7, ADR-016).
 *
 * The token is `@IsString()` and NOT `@IsUUID()`, deliberately: it is two v4
 * UUIDs concatenated with the hyphens stripped (244 bits), so a UUID validator
 * would reject every legitimate token. `MaxLength` is a denial-of-service bound
 * on the SHA-256 input, not a correctness check — a wrong-length token simply
 * fails to match a stored hash, which is the same rejection as any other wrong
 * token.
 *
 * The password rule is `RegisterDto`'s, deliberately identical: this is the other
 * way a person first sets a credential, and the two must not be able to drift
 * into different minimum strengths.
 */
export class SetPasswordDto {
  @ApiProperty({ example: 'a1b2c3...', description: 'The invite token from the invitation link.' })
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  token!: string;

  @ApiProperty({ example: 'correct horse battery staple', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password!: string;
}
