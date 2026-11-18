import type { DatabaseStatus } from '../../db/database.js';

export type DatabaseCheck = () => Promise<DatabaseStatus>;

export function createHealthService(checkDatabase: DatabaseCheck) {
  return {
    live: () => ({ status: 'ok' as const, service: 'streeteye-backend' as const }),
    async ready() {
      // Defensive catch also covers an unexpected adapter failure.
      const database = await checkDatabase().catch(() => 'down' as const);
      return { status: database === 'up' ? 'ready' as const : 'not_ready' as const, checks: { database } };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
