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
import { Member, MembershipsService, PendingInvite } from './memberships.service';

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

  /**
   * THE RESPONSE IS UNIFORM ACROSS BOTH INVITE BRANCHES — identical body,
   * identical 201 — and that uniformity is a security property, not tidiness.
   *
   * Until step 8 this returned `{ membershipId, userId, userCreated }`.
   * `userCreated` is an ACCOUNT-EXISTENCE ORACLE: any tenant admin could invite
   * an address, read the flag, and learn whether that person holds an account
   * ANYWHERE in the system — including in tenants the caller cannot see and has
   * no relationship with. The membership model is precisely what makes that
   * cross-tenant: `users` is global identity (ADR-006 §2), so "already exists"
   * is a fact about the whole system rather than about this workspace.
   *
   * `membershipId` and `userId` are dropped with it. Neither leaks on its own —
   * the invitee is a member of the caller's tenant either way, so both are
   * readable from `GET /users` immediately afterwards — but a body that varies
   * in SHAPE between branches invites exactly the kind of client that starts
   * depending on the difference. One body, one status, no branch.
   *
   * The residual timing difference (create-identity + membership costs more than
   * a membership insert alone) is accepted for v1.0 and recorded in ADR-016: the
   * caller is an authenticated, rate-limited admin, and what leaks is
   * existence-anywhere rather than anything tenant-scoped. The BullMQ mailer in
   * stretch scope erases it for free by making invite fire-and-return.
   */
  @Post()
  @RequiresRole('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Invite someone to the active workspace. The response is identical whether or not the email already had an account.',
  })
  async invite(@Body() dto: InviteMemberDto): Promise<{ message: string }> {
    await this.memberships.invite(dto);
    return { message: 'Invitation sent.' };
  }

  /**
   * Pending invites for the active workspace, each with a freshly minted token.
   *
   * ADMIN-GATED, unlike `GET /` — and the asymmetry is deliberate. The member
   * list is open to every member by decision (ADR-006 §3, co-member visibility);
   * this one hands out redemption credentials, so it carries `@RequiresRole` at
   * the gate AND an independent live-admin check inside
   * `list_pending_invites` — the two-layer shape the step-5 write endpoints use,
   * with the same rule that neither layer may be relaxed on the strength of the
   * other.
   *
   * Placed under `/users/pending` rather than as a `?pending=true` filter on the
   * list: a query parameter that changes a response from "public to the tenant"
   * to "admin-only, contains secrets" is one forgotten guard away from leaking,
   * and it would put two different authorization rules on one route.
   */
  @Get('pending')
  @RequiresRole('admin')
  @ApiOperation({
    summary:
      'List pending invites for the active workspace, minting a fresh redemption token for each. Admin only.',
  })
  async pending(): Promise<PendingInvite[]> {
    return this.memberships.pendingInvites();
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
