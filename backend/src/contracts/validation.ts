import { Ajv, type SchemaObject, type ValidateFunction } from 'ajv';
import { z } from 'zod';
import { schemas } from './schemas.js';

// OAS 3.0 uses boolean exclusiveMinimum/Maximum, JSON Schema draft-07 uses numbers.
function forAjv(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forAjv);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'discriminator').map(([key, item]) => [key, forAjv(item)]));
  for (const [exclusive, boundary] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (typeof source[exclusive] === 'boolean') {
      if (source[exclusive]) { result[exclusive] = source[boundary]; delete result[boundary]; }
      else delete result[exclusive];
    }
  }
  return result;
}
export function createValidator(coerceTypes = false) {
  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes, validateFormats: true });
  ajv.addFormat('uuid', { type: 'string', validate: (value) => z.uuid().safeParse(value).success });
  ajv.addFormat('date-time', { type: 'string', validate: (value) => z.iso.datetime().safeParse(value).success });
  ajv.addFormat('uri-reference', { type: 'string', validate: (value) => {
    try { const url = new URL(value, 'https://example.invalid'); return ['http:', 'https:'].includes(url.protocol); } catch { return false; }
  } });
  ajv.addSchema(forAjv({ $id: 'streeteye', components: { schemas } }) as SchemaObject);
  const cache = new Map<string, ValidateFunction>();
  return (name: string): ValidateFunction => {
    let validate = cache.get(name);
    if (!validate) { validate = ajv.compile({ $ref: `streeteye#/components/schemas/${name}` }); cache.set(name, validate); }
    return validate;
  };
}
