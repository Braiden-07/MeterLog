import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.setGlobalPrefix('api/v1');
  app.use(helmet());

  // Credentials are sent with every request (session cookie, ADR-001), so the
  // origin must be an allow-list — a wildcard is not permitted with credentials.
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // PROJECT_BRIEF §6: reject unknown fields rather than silently dropping them.
      forbidNonWhitelisted: true,
    }),
  );

  const openApi = new DocumentBuilder()
    .setTitle('MeterLog API')
    .setDescription('Multi-tenant asset & utility-meter traceability')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('api/v1/docs', app, SwaggerModule.createDocument(app, openApi));

  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
