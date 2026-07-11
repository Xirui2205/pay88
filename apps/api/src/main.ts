import 'reflect-metadata';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { requestContextMiddleware } from './common/request-context';
import { configureMaintainedOpenApi } from './openapi-contract';
import { configureJsonSerialization } from './common/json-serialization';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureJsonSerialization(app);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestContextMiddleware);
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const developmentOrigins = [
    'http://localhost:4173',
    'http://localhost:4174',
    'http://localhost:4175',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
  ];
  const allowedOrigins = new Set(
    configuredOrigins.length || process.env.NODE_ENV === 'production' ? configuredOrigins : developmentOrigins,
  );
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      // Server-to-server requests do not carry Origin. Browser origins are exact-match only.
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('CORS origin is not allowed'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-reauth-token', 'x-break-glass-reason'],
    exposedHeaders: ['x-request-id'],
    credentials: false,
    maxAge: 600,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  // Serve the same reviewed, linted 3.1 contract used for SDKs and fixtures.
  // Reflection-only output would omit the Zod request/response schemas.
  configureMaintainedOpenApi(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
