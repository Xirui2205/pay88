import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const CONTRACT_FILE = 'telebirr-p2p-v1.yaml';

export function loadMaintainedOpenApiContract(): OpenAPIObject {
  const configured = process.env.OPENAPI_CONTRACT_PATH?.trim();
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    resolve(process.cwd(), 'docs', 'openapi', CONTRACT_FILE),
    resolve(process.cwd(), '..', '..', 'docs', 'openapi', CONTRACT_FILE),
    resolve(__dirname, '..', '..', '..', 'docs', 'openapi', CONTRACT_FILE),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));
  if (!contractPath) throw new Error(`Maintained OpenAPI contract was not found (${CONTRACT_FILE})`);

  const document = parse(readFileSync(contractPath, 'utf8')) as Partial<OpenAPIObject>;
  if (
    document.openapi !== '3.1.0' ||
    typeof document.info !== 'object' ||
    typeof document.paths !== 'object' ||
    typeof document.components !== 'object'
  ) {
    throw new Error('Maintained OpenAPI contract is missing required OpenAPI 3.1 sections');
  }
  return document as OpenAPIObject;
}

export function configureMaintainedOpenApi(app: INestApplication): OpenAPIObject {
  const contract = loadMaintainedOpenApiContract();
  SwaggerModule.setup('docs', app, contract, { jsonDocumentUrl: 'docs/openapi.json' });
  return contract;
}
