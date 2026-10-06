import { GoogleAdsClient } from './ads/client.js';
import { MetaClient } from './meta/client.js';
import { OpsBudget } from './ads/budget.js';
import { McpOAuthProvider } from './auth/provider.js';
import { OAuthStore } from './auth/store.js';
import { loadConfig, mcpResourceUrl } from './config.js';
import { createApp } from './http/app.js';
import { SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
import { TtlCache } from './util/cache.js';
import { createLogger } from './util/logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);
const store = new OAuthStore(config.DATA_DIR);
const provider = new McpOAuthProvider(config, store, mcpResourceUrl(config), logger);
const budget = new OpsBudget(config.DATA_DIR, config.GOOGLE_ADS_DAILY_OPS_BUDGET);
const ads = new GoogleAdsClient(config, budget, logger);
const meta = config.META_ACCESS_TOKEN ? new MetaClient(config, logger) : undefined;
const cache = new TtlCache<unknown>(config.CACHE_TTL_HOURS * 3_600_000);

const app = createApp({ config, provider, toolContext: { config, ads, meta, budget, cache, logger }, logger });
const server = app.listen(config.PORT, '0.0.0.0', () => {
  logger.info('server started', {
    service: SERVER_NAME,
    version: SERVER_VERSION,
    port: config.PORT,
    mcp_url: mcpResourceUrl(config).href,
    access_level: config.GOOGLE_ADS_ACCESS_LEVEL,
    meta_tools: Boolean(meta),
    registered_clients: store.countClients(),
  });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
