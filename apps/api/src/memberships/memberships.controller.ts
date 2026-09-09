import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresRole } from '../common/auth/requires-role.decorator';
import { RequiresSession } from '../common/auth/requires-session.decorator';
import { ChangeMemberRoleDto, InviteMemberDto } from './dto/memberships.dto';
import { Member, MembershipsService } from './memberships.service';

/**
 * The Users module is a MEMBERSHIPS module in substance (ADR-006 §7): the
 * resource being managed is a person's access to the active workspace, not the
 * person. Revoking removes the membership and leaves the human — and their
 * memberships in other tenants — untouched.
 *
 * `:id` is a MEMBERSHIP id, not a user id. Decided at the step-5 gate: it makes
 * §7's clause (b) — "the target row belongs to the active tenant" — a direct
 * check on the row being written, rather than a resolution step that has to be
 * trusted to have scoped correctly.
 *
 * **Writes are admin-gated; the read is not.** `GET` returns the whole member
 * list to any member of the active tenant, by decision (ADR-006 §3): co-member
 * visibility is the right default for team SaaS, and gating a read on role means
 * putting a role term in a read policy, which is the shape that produced OPEN-5.
 * The absence of `@RequiresRole` on `list` is deliberate — do not "fix" it.
 *
 * Two checks stand behind every write here, and they are independent by design:
 * this gate, which produces a clean 403 and is where role policy for the API is
 * expressed, and the `SECURITY DEFINER` function body, which re-checks the caller
 * is a live admin of the active tenant. The body check is the one that cannot be
 * bypassed — the functions are `EXECUTE`-able by `meterlog_app`, so anything
 * holding that connection can call them directly, guard or no guard (ADR-006 §7).
 * Neither check may be relaxed on the strength of the other.
 */
@ApiTags('users')
@Controller('users')
@RequiresSession()
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @ApiOperation({
    summary: 'List members of the active workspace. Available to any member, by decision.',
  })
  async list(): Promise<Member[]> {
    return this.memberships.list();
  }

  @Post()
  @RequiresRole('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Invite someone to the active workspace. An existing email attaches a new membership; a new one creates the identity too.',
  })
  async invite(
    @Body() dto: InviteMemberDto,
  ): Promise<{ membershipId: string; userId: string; userCreated: boolean }> {
    return this.memberships.invite(dto);
  }

  @Patch(':id')
  @RequiresRole('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Change a membership's role. 409 if it would leave the workspace with no admin.",
  })
  async changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeMemberRoleDto,
  ): Promise<void> {
    await this.memberships.changeRole(id, dto.role);
  }

  @Delete(':id')
  @RequiresRole('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke access to the active workspace (soft delete). 409 if it would leave no admin.',
  })
  async revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.memberships.revoke(id);
  }
}
