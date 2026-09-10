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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresRole } from '../common/auth/requires-role.decorator';
import { RequiresSession } from '../common/auth/requires-session.decorator';
import type { Page } from '../common/pagination/cursor';
import { type Asset, type AssetEvent, AssetsService, type Reading } from './assets.service';
import {
  CreateAssetDto,
  CreateReadingDto,
  ListAssetsQuery,
  ListEventsQuery,
  ListReadingsQuery,
  PostEventDto,
  UpdateAssetDto,
} from './dto/assets.dto';

/**
 * The asset read surface (step 6 phase 3a).
 *
 * **`@RequiresSession()` and deliberately NO `@RequiresRole()` anywhere in this
 * controller.** Reads are open to all three roles by decision (ARCHITECTURE
 * §9.1): admin, technician and auditor all see the same rows. The absence of a
 * role gate is intentional and must not be "fixed" — an auditor is defined as
 * read-only, not read-restricted, and gating reads by role is the shape that
 * pushes a role term toward a read policy (ADR-006 §3, the OPEN-5 class).
 *
 * Tenant isolation is not implemented here AT ALL. The interceptor sets
 * `app.current_tenant` on the request transaction before any handler runs, so
 * every query below is scoped by RLS. These handlers query and paginate; they do
 * not filter by tenant, and adding such a filter would hide a policy regression.
 *
 * **The writes below are role-gated; the reads above are not.** `@RequiresRole`
 * is resolved INSIDE the interceptor at step (5), after the role has been re-read
 * from the database for this request — never in a `CanActivate` guard, which Nest
 * runs before interceptors and which would therefore 500 on every request
 * including the admin's (ARCHITECTURE §9, measured at the step-5 gate).
 *
 * A caller with no ACTIVE TENANT has a null role, and a null role fails the gate
 * with 403 rather than erroring — there is no workspace in which they hold the
 * required role, so "denied" is the correct answer, not "broken".
 *
 * **Every §9.1 cell is enforced as of phase 3c.** Reads un-gated;
 * create/update/reading at admin + technician; and the two 3c cells below —
 * transitions at admin + technician, decommission **admin only**, because §9.1
 * draws the admin-only line at the destructive act.
 *
 * **No route here mutates an append-only resource**, and that is asserted rather
 * than observed: `test/api/route-inventory.spec.ts` enumerates the registered
 * routes and fails if any PATCH/PUT/DELETE targets `events` or `readings`. The
 * database already refuses such a write (catalog assertion 13 pins the
 * `SELECT, INSERT`-only grant); the guard stops an endpoint from *offering* it.
 * `DELETE /assets/:id` is deliberately not caught — `assets` is soft-deleted, not
 * append-only.
 */
@ApiTags('assets')
@Controller('assets')
@RequiresSession()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List assets in the active workspace. Cursor-paginated; excludes decommissioned assets by default.',
  })
  async list(@Query() query: ListAssetsQuery): Promise<Page<Asset>> {
    return this.assets.list(query);
  }

  @Post()
  @RequiresRole('admin', 'technician')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Register an asset. Writes the asset plus its created + installed genesis events in one transaction.',
  })
  async create(@Body() dto: CreateAssetDto): Promise<Asset> {
    return this.assets.create(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'One asset. Returns decommissioned assets too — the soft-delete filter is a list default, not an existence check.',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Asset> {
    return this.assets.findOne(id);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'The asset lifecycle log, newest first. Append-only.' })
  async events(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListEventsQuery,
  ): Promise<Page<AssetEvent>> {
    return this.assets.listEvents(id, query);
  }

  @Get(':id/readings')
  @ApiOperation({ summary: 'Meter readings for an asset, newest first. Append-only.' })
  async readings(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListReadingsQuery,
  ): Promise<Page<Reading>> {
    return this.assets.listReadings(id, query);
  }

  @Patch(':id')
  @RequiresRole('admin', 'technician')
  @ApiOperation({
    summary:
      'Update asset metadata. Emits nothing. `status` is NOT accepted — transitions go through POST /events (3c).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ): Promise<Asset> {
    return this.assets.update(id, dto);
  }

  @Post(':id/readings')
  @RequiresRole('admin', 'technician')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a meter reading. Emits no lifecycle event.' })
  async createReading(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReadingDto,
  ): Promise<Reading> {
    return this.assets.createReading(id, dto);
  }

  @Post(':id/events')
  @RequiresRole('admin', 'technician')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Apply a lifecycle transition. The client names the TRANSITION; the target status is derived from the graph.',
    description:
      'Postable: activated, maintenance_started, maintenance_completed. 422 for created/installed (use POST /assets) and decommissioned (use DELETE /assets/:id); 409 when the transition is illegal from the current status.',
  })
  async postEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostEventDto,
  ): Promise<AssetEvent> {
    return this.assets.applyTransition(id, dto);
  }

  @Delete(':id')
  @RequiresRole('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Decommission an asset (soft delete). Sets status + deleted_at and emits the decommissioned event, atomically.',
    description:
      'Admin only — the destructive act (ARCHITECTURE §9.1). 409 if already decommissioned: the state is terminal, so this is not an idempotent no-op.',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.assets.decommission(id);
  }
}
