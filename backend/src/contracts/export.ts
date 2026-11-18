import { writeFile } from 'node:fs/promises';
import { buildOpenApi } from './openapi.js';
import { examples, catalog } from './fixtures.js';
await writeFile(new URL('../docs/openapi.json', import.meta.url), `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
await writeFile(new URL('../docs/be04-examples.json', import.meta.url), `${JSON.stringify({ ...examples, catalog: catalog() }, null, 2)}\n`);
console.log('Exported OpenAPI and synthetic BE-04 examples.');
