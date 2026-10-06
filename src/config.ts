import * as z from 'zod';

const customerId = z
  .string()
  .transform((s) => s.replace(/-/g, '').trim())
  .pipe(z.string().regex(/^\d{10}$/, 'must be a 10-digit Google Ads customer ID'));

const schema = z.object({
  PUBLIC_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATA_DIR: z.string().default('./data'),

  MCP_ACCESS_KEY: z.string().min(16, 'must be at least 16 characters'),
  MCP_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  MCP_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MCP_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MCP_ALLOWED_REDIRECT_URIS: z.string().default(''),

  GOOGLE_ADS_CLIENT_ID: z.string().min(1),
  GOOGLE_ADS_CLIENT_SECRET: z.string().min(1),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().min(1),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().default(''),
  GOOGLE_ADS_CUSTOMER_ID: customerId,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z
    .string()
    .default('')
    .transform((s) => s.replace(/-/g, '').trim())
    .pipe(z.string().regex(/^(\d{10})?$/, 'must be empty or a 10-digit ID')),
  GOOGLE_ADS_API_VERSION: z.string().regex(/^v\d+$/).default('v23'),
  GOOGLE_ADS_ACCESS_LEVEL: z.enum(['explorer', 'basic']).default('explorer'),
  GOOGLE_ADS_DAILY_OPS_BUDGET: z.coerce.number().int().positive().default(2500),

  DEFAULT_LANGUAGE_CODE: z.string().min(2).max(5).default('pt'),
  DEFAULT_COUNTRY_CODE: z
    .string()
    .length(2)
    .transform((s) => s.toUpperCase())
    .default('BR'),
  CACHE_TTL_HOURS: z.coerce.number().min(0).default(24),
});

export type Config = z.infer<typeof schema>;

/**
 * Parses and validates the environment. On failure it reports only the
 * variable names and the rule they broke, never their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration. Fix these environment variables:\n${problems}`);
  }
  return result.data;
}

/** URL of the MCP endpoint; also the OAuth "resource" Claude must see. */
export function mcpResourceUrl(config: Config): URL {
  return new URL(`${config.PUBLIC_URL}/mcp`);
}
