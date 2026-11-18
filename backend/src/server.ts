import 'dotenv/config';
import { createServer } from 'node:http';
import { parseEnv } from './config/env.js';
import { createDatabase } from './db/database.js';
import { createApp } from './app.js';
import { logger } from './shared/logger.js';
import { createTokenVerifier } from './modules/auth/auth.verifier.js';
import { createContributorRepository } from './modules/auth/auth.repository.js';

async function main() {
  const config = parseEnv(process.env);
  const database = createDatabase(config, logger);
  const server = createServer(createApp(config, database.check, logger, {
    verifyToken: createTokenVerifier(config), resolveContributor: createContributorRepository(database.pool),
  }, database.pool));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.PORT, config.HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch(async (error: unknown) => { await database.close(); throw error; });

  logger('server.started', { host: config.HOST, port: config.PORT, databaseConfigured: Boolean(config.DATABASE_URL) });
  let decayRunning=false;
  const decay=setInterval(async()=>{
    if(decayRunning||!database.pool) return;
    decayRunning=true;
    try { await database.pool.query('SELECT streeteye_private.decay_batch()'); }
    catch { logger('score.decay_failed'); }
    finally { decayRunning=false; }
  },60_000);
  decay.unref();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(decay);
    logger('server.stopping');
    const timer = setTimeout(() => { logger('server.shutdown_timeout'); process.exit(1); }, 10000);
    timer.unref();
    server.close(() => {
      void database.close().then(() => {
        clearTimeout(timer);
        logger('server.stopped');
      }).catch(() => { logger('server.shutdown_failed'); process.exit(1); });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  // Validation errors contain safe field names. Other errors may contain secrets.
  const message = error instanceof Error && error.message.startsWith('Invalid environment:')
    ? error.message : 'Could not start server. Check HOST/PORT and database certificate configuration.';
  logger('server.start_failed', { message });
  process.exitCode = 1;
});
