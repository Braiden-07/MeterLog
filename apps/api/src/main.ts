import 'reflect-metadata';

// FIRST, AND BEFORE ANY OTHER APPLICATION IMPORT. `Sentry.init` has to run
// ahead of the modules it instruments, so this import and the call below sit
// above everything else in the file. It is a no-op without a DSN.
import { initSentry } from './common/observability/sentry';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, configureApp, mountOpenApi } from './bootstrap';

const sentryArmed = initSentry();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { ...NEST_APP_OPTIONS, bufferLogs: true });

  // Structured logs. `bufferLogs` above is what makes this work rather than
  // merely tidy: Nest holds every boot-time log until a logger is attached, so
  // nothing from the DI phase — including the fail-closed refusals that make a
  // missing secret a failed deploy — is lost to the default console logger.
  app.useLogger(app.get(Logger));

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

  // Said once, at boot, because a reporter that is silently off looks exactly
  // like one that is working and has nothing to report. Whoever reads the first
  // page of deploy logs should not have to guess which.
  app
    .get(Logger)
    .log(
      sentryArmed
        ? 'Sentry error reporting is ARMED.'
        : 'Sentry error reporting is OFF (no SENTRY_DSN set).',
    );
}

void bootstrap();
