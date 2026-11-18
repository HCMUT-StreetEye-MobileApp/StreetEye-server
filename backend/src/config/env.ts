import { z } from 'zod';

// Blank values in .env behave like omitted optional values.
const optionalText = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: optionalText,
  DIRECT_URL: optionalText,
  DB_SSL: z.enum(['verify-full', 'disable']).default('verify-full'),
  DB_SSL_CA_PATH: optionalText,
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  DB_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(3000),
  SUPABASE_URL: optionalText,
  DATA_MODE: z.enum(['demo','pilot']).default('demo'),
  AUTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(15000).default(5000),
  AUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(120).default(5),
}).superRefine((value, context) => {
  if (value.SUPABASE_URL) {
    try {
      const url = new URL(value.SUPABASE_URL);
      if (url.protocol !== 'https:' || url.origin !== value.SUPABASE_URL || url.username || url.password) throw new Error();
    } catch {
      context.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'Use the HTTPS project origin without a path or trailing slash.' });
    }
  }
  if (value.NODE_ENV === 'production') {
    for (const field of ['DATABASE_URL', 'SUPABASE_URL'] as const) {
      if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'Required in production.' });
    }
    if (value.DB_SSL !== 'verify-full') context.addIssue({ code: 'custom', path: ['DB_SSL'], message: 'Production requires verified TLS.' });
  }
  for (const origin of value.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch {
      context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Use comma-separated HTTP(S) origins without paths or trailing slashes.' });
    }
  }
  for (const field of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if (!value[field]) continue;
    try {
      const url = new URL(value[field]);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) throw new Error();
      if (field === 'DATABASE_URL' && value.NODE_ENV === 'production'
        && !/^streeteye_backend(?:\.[a-z0-9]+)?$/.test(decodeURIComponent(url.username))) {
        context.addIssue({ code: 'custom', path: [field], message: 'Production must use the restricted streeteye_backend login; keep migration credentials separate.' });
      }
      if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith('ssl') || key === 'uselibpqcompat')) {
        context.addIssue({ code: 'custom', path: [field], message: 'Remove SSL URL parameters; configure DB_SSL and DB_SSL_CA_PATH instead.' });
      }
    } catch {
      context.addIssue({ code: 'custom', path: [field], message: 'Use a PostgreSQL connection URL with a host and database name; percent-encode the password.' });
    }
  }
  if (value.DB_SSL === 'disable' && value.DB_SSL_CA_PATH) {
    context.addIssue({ code: 'custom', path: ['DB_SSL_CA_PATH'], message: 'A CA file requires DB_SSL=verify-full.' });
  }
});

export type AppConfig = z.infer<typeof schema>;

export function parseEnv(env: NodeJS.ProcessEnv): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report field names and validation messages, never the raw environment.
    throw new Error(`Invalid environment: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
