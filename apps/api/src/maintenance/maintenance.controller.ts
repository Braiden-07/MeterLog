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
import {
  CreateMaintenanceRecordDto,
  ListMaintenanceQuery,
  UpdateMaintenanceRecordDto,
} from './dto/maintenance.dto';
import { type MaintenanceRecord, MaintenanceService } from './maintenance.service';

/**
 * Maintenance records — the fourth v1.0 domain child, and the only one with a
 * general SELECT / INSERT / UPDATE / soft-DELETE surface (ADR-008).
 *
 * **Reads un-gated, writes at admin + technician, and `DELETE` is NOT admin-only
 * here** — which differs from `assets` deliberately. On `assets`, `DELETE` is
 * decommissioning a physical unit: destructive, irreversible in practice, and
 * admin-only per ARCHITECTURE §9.1. Here it is retracting a record of work, which
 * the technician who filed it should be able to withdraw — and it is recoverable,
 * because the row persists. Treating the two as the same operation because they
 * share a verb would be the mistake.
 *
 * The soft delete is an `UPDATE`: the app role holds **no `DELETE` privilege** on
 * this table, asserted as an equality by catalog assertion 14. That is what makes
 * "soft delete only" a property of the database rather than a convention here.
 *
 * Tenant isolation is not implemented in this controller at all — the interceptor
 * sets `app.current_tenant` on the request transaction, so the policy scopes every
 * query. These handlers query and paginate.
 */
@ApiTags('maintenance-records')
@Controller('maintenance-records')
@RequiresSession()
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get()
  @ApiOperation({
    summary:
      'List maintenance records in the active workspace. Cursor-paginated; excludes soft-deleted records by default.',
  })
  async list(@Query() query: ListMaintenanceQuery): Promise<Page<MaintenanceRecord>> {
    return this.maintenance.list(query);
  }

  @Post()
  @RequiresRole('admin', 'technician')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Record maintenance performed on an asset. The tenant comes from the session, never the body.',
  })
  async create(@Body() dto: CreateMaintenanceRecordDto): Promise<MaintenanceRecord> {
    return this.maintenance.create(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'One maintenance record. Returns soft-deleted records too — the liveness filter is a list default, not an existence check.',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<MaintenanceRecord> {
    return this.maintenance.findOne(id);
  }

  @Patch(':id')
  @RequiresRole('admin', 'technician')
  @ApiOperation({
    summary:
      'Edit a maintenance record. The first general field edit in the domain; emits no lifecycle event. assetId is not editable — records are not reparentable.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMaintenanceRecordDto,
  ): Promise<MaintenanceRecord> {
    return this.maintenance.update(id, dto);
  }

  @Delete(':id')
  @RequiresRole('admin', 'technician')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete a maintenance record (an UPDATE of deleted_at). The row persists; hard delete is deferred until after the audit module (OPEN-9).',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.maintenance.remove(id);
  }
}
