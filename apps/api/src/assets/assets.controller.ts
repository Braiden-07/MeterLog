import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresSession } from '../common/auth/requires-session.decorator';
import type { Page } from '../common/pagination/cursor';
import { type Asset, type AssetEvent, AssetsService, type Reading } from './assets.service';
import { ListAssetsQuery, ListEventsQuery, ListReadingsQuery } from './dto/assets.dto';

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
 * Writes land in phases 3b (create/update) and 3c (lifecycle transitions). No
 * mutation route exists yet, which is why there is no route-inventory guard here
 * — that arrives with the first mutation.
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
}
