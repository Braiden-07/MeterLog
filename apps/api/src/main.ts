import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { ...NEST_APP_OPTIONS, bufferLogs: true });

  // The request-pipeline floor — prefix, parsers, headers, validation. Shared
  // with every acceptance test so the suite exercises the pipeline this process
  // actually runs, rather than a hand-copied approximation of it (see
  // bootstrap.ts).
  configureApp(app);

  const openApi = new DocumentBuilder()
    .setTitle('MeterLog API')
    .setDescription('Multi-tenant asset & utility-meter traceability')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('api/v1/docs', app, SwaggerModule.createDocument(app, openApi));

  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
