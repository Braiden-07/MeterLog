import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  // Target of the uptime monitor (PROJECT_BRIEF §10) and of the post-deploy
  // smoke test (§9). Unauthenticated by design, so it must never report
  // anything that isn't safe to expose publicly.
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  check(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }
}
