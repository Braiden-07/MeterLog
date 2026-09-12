import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresRole } from '../common/auth/requires-role.decorator';
import { RequiresSession } from '../common/auth/requires-session.decorator';

import { AuditService } from './audit.service';
import { AuditPage, ListAuditQuery } from './dto/audit.dto';

/**
 * The audit trail read surface (step 7 phase 7b).
 *
 * **THIS IS WHERE ADR-012's RECORDED GATE BECOMES AN ENFORCED ONE.** The trail is
 * readable by **admin and auditor**, and by nobody else. That is not an arbitrary
 * pair: `PROJECT_BRIEF` §12 (:263) names the trail "viewable by admin/auditor",
 * §6 (:166) scopes `GET /audit` the same way, and §1 (:14) describes auditors as
 * "read-only + audit access". **Gate the trail to admins and the auditor role
 * collapses into a technician who cannot write** — a role with no capability of
 * its own, in a three-role matrix whose whole purpose is that the roles differ.
 *
 * Note the CONTRAST with `AssetsController`, which deliberately carries no role
 * gate on its reads because an auditor must see the same asset rows everyone
 * else does. The auditor's distinguishing capability is this endpoint, and only
 * this endpoint — which is why the auditor POSITIVE test is non-negotiable
 * rather than a nice-to-have. Every RBAC negative in `audit-read.spec.ts` passes
 * identically against an admin-only implementation, so without the positive the
 * bug reaches v1.0 with a green suite.
 *
 * **There is no `GET /audit/:id`, and that is a decision** (ADR-014). The brief
 * specifies only the collection, and the drill-down it anticipates is
 * `?tableName=&rowId=` — "everything that ever happened to this row". The
 * reasoning is recorded so it stays pre-decided: under RLS a cross-tenant row is
 * simply INVISIBLE, so a naive `findOne` would return **success with nothing**
 * rather than a refusal. Such an endpoint must return a hard **404**, never
 * 200-with-null. That is the zero-rows-is-not-an-error trap for the fourth time.
 *
 * **No route here mutates anything, and that is asserted rather than observed.**
 * `test/api/route-inventory.spec.ts` derives its resource set from
 * `APPEND_ONLY_TABLES` and refuses any PATCH/PUT/DELETE on the `audit` segment —
 * and, since 7a split that check by writer, refuses a **POST** too: the app role
 * holds no INSERT on `audit_log` at all (ADR-010), so an endpoint offering one
 * could only ever 500 on `permission denied`.
 */
@ApiTags('audit')
@Controller('audit')
@RequiresSession()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequiresRole('admin', 'auditor')
  @ApiOperation({
    summary:
      'The audit trail for the active workspace. Admin and auditor only. Cursor-paginated, newest first; filter by action, by table/row drill-down, by actor, and by half-open date range.',
  })
  async list(@Query() query: ListAuditQuery): Promise<AuditPage> {
    return this.audit.list(query);
  }
}
