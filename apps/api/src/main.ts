import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, configureApp, mountOpenApi } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { ...NEST_APP_OPTIONS, bufferLogs: true });

  // The request-pipeline floor — prefix, parsers, headers, validation. Shared
  // with every acceptance test so the suite exercises the pipeline this process
  // actually runs, rather than a hand-copied approximation of it (see
  // bootstrap.ts).
  configureApp(app);

  // The public OpenAPI page at `/api/v1/docs`. Deliberately reachable without a
  // session — what makes that safe rather than merely intended is argued at
  // `mountOpenApi`, and pinned by `test/api/openapi-docs.spec.ts` so removing
  // the exposure is a reviewed change rather than a reflex.
  //
  // Defined in bootstrap.ts rather than inline here so that the spec asserting
  // the exposure calls THIS mount instead of building its own, which would
  // assert a copy. It stays out of `configureApp` because generating the
  // document scans every controller and the acceptance suite has no use for it.
  mountOpenApi(app);

  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
