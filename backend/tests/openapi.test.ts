import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { readFile } from 'node:fs/promises';
import { buildOpenApi, businessPaths } from '../src/contracts/openapi.js';
import { createValidator } from '../src/contracts/validation.js';

test('OpenAPI passes schema validation and reference resolution', async () => {
  const api = await SwaggerParser.validate(fileURLToPath(new URL('../src/docs/openapi.json', import.meta.url)));
  assert.equal(api.info.version, '0.3.0');
});

test('exported contract is synchronized with source and has distinct operation IDs', async () => {
  const exported = JSON.parse(await readFile(new URL('../src/docs/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(exported, buildOpenApi());
  const operations = Object.values(businessPaths).flatMap(Object.values);
  assert.equal(operations.length, 9);
  assert.equal(new Set(operations.map((op) => op.operationId)).size, operations.length);
  assert.equal(operations.filter((op) => op['x-implementation'] === 'implemented').length, 9);
});

test('every business request and response example validates against its declared schema', () => {
  const validator = createValidator();
  let checked = 0;
  const validateMedia = (media: { schema: { $ref: string }; examples: Record<string, { value: unknown }> }) => {
    const name = media.schema.$ref.split('/').at(-1)!;
    const validate = validator(name);
    for (const [example, { value }] of Object.entries(media.examples)) {
      assert.ok(validate(value), `${name}/${example}: ${JSON.stringify(validate.errors)}`);
      checked++;
    }
  };
  for (const methods of Object.values(businessPaths)) {
    for (const operation of Object.values(methods)) {
      if (operation.requestBody) validateMedia((operation.requestBody as { content: { 'application/json': Parameters<typeof validateMedia>[0] } }).content['application/json']);
      for (const response of Object.values(operation.responses)) validateMedia(response.content['application/json'] as Parameters<typeof validateMedia>[0]);
    }
  }
  assert.ok(checked > 80);
});
