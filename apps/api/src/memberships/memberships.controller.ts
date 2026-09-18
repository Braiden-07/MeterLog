import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import {
  Member,
  MembershipsService,
  MintedInviteToken,
  PendingInvite,
} from './memberships.service';

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
   * Pending invites for the active workspace — METADATA ONLY (OPEN-14).
   *
   * THIS GET IS SAFE, AND IT HAD TO BECOME SO BEFORE THE ADMIN UI. Until the
   * pending split it returned a freshly minted token per row, which made the
   * response itself the state change. Two consequences, both real: it broke the
   * condition the ADR-001 amendment attaches to `SameSite=Lax` — the cookie is
   * withheld from a cross-site POST but still sent on a top-level cross-site GET,
   * so Lax is CSRF protection only while every GET is safe in the RFC 9110 §9.2.1
   * sense — and a window-focus refetch was a denial of service against a link the
   * admin had already emailed. The recorded test for a new GET is whether it
   * would still be correct if the side effect were skipped; this one now is,
   * because there is no side effect.
   *
   * STILL ADMIN-GATED, unlike `GET /`, even though it no longer carries
   * credentials. The member list is open to every member by decision (ADR-006 §3,
   * co-member visibility); who has NOT yet activated their account is
   * administrative state, and the gate stays where ADR-016 put it rather than
   * being relaxed on the strength of the token having left the body.
   *
   * Placed under `/users/pending` rather than as a `?pending=true` filter on the
   * list: a query parameter that changes a response from "public to the tenant"
   * to "admin-only" is one forgotten guard away from leaking, and it would put
   * two different authorization rules on one route.
   */
  @Get('pending')
  @RequiresRole('admin')
  @ApiOperation({
    summary:
      'List pending invites for the active workspace. Metadata only — no token, and no writes. Admin only.',
  })
  async pending(): Promise<PendingInvite[]> {
    return this.memberships.pendingInvites();
  }

  /**
   * Mint a redemption token for one pending invite (OPEN-14).
   *
   * THE ONE SECRET RESPONSE BODY IN THIS API, and the only route that carries
   * `Cache-Control: no-store`. The header is on THIS route specifically rather
   * than applied globally, because a blanket `no-store` would say nothing — the
   * point is that exactly one response in the system is a live credential, and a
   * header that appears on every route could not mark it. Without it the token is
   * eligible for the browser's disk cache and for any intermediary's, which is a
   * credential at rest in the two places the design has been careful to keep it
   * out of.
   *
   * 201, NOT 200. The call CREATES a token resource — it is not a read of one
   * that already existed, and it cannot be: the table stores a SHA-256 hash, so
   * there is no stored plaintext this endpoint could ever return. The brief
   * permits either status; 201 is the named choice and is asserted, so it cannot
   * drift.
   *
   * IT IS A POST BECAUSE IT WRITES — which is the whole substance of the split,
   * not a REST formality. As a POST the `SameSite=Lax` cookie is withheld from a
   * cross-site invocation, so the minting capability is no longer reachable by
   * navigating an admin's browser at the URL.
   *
   * TWO LAYERS, as everywhere else in this module: `@RequiresRole('admin')` at
   * the gate answering `FORBIDDEN_ROLE`, and an independent live-admin check
   * inside `mint_invite_token` answering `NOT_ADMIN`. Different codes on purpose
   * — the step-5 lesson — so a test asserting one cannot be satisfied by the
   * other layer, and neither may be relaxed on the strength of the other.
   */
  @Post('pending/:membershipId/token')
  @RequiresRole('admin')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Mint a fresh redemption token for one pending invite, invalidating any previous one. The response body is a live credential and is not cacheable. Admin only.',
  })
  async mintToken(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<MintedInviteToken> {
    return this.memberships.mintInviteToken(membershipId);
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
