// Deliberately no dotenv, database adapter, Supabase or real authentication here.
import { createServer } from 'node:http';
import { createMockApp } from './app.js';

if (process.env.NODE_ENV === 'production') throw new Error('Local mock cannot run with NODE_ENV=production.');
const port = Number(process.env.MOCK_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MOCK_PORT.');
const host = process.env.MOCK_HOST ?? '127.0.0.1';
const server = createServer(createMockApp());
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.once('error', () => { console.error('Could not start mock. Check MOCK_HOST/MOCK_PORT.'); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`StreetEye LOCAL MOCK: http://${host}:${port}/docs/ — synthetic demo only, no database.`);
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(() => { clearTimeout(timeout); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
