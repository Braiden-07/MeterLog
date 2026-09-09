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
