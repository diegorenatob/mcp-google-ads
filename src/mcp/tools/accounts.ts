import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guardGaql } from '../../ads/gaql.js';
import { READ_ONLY, microsToUnits, ok, resolveCustomerId, run, type ToolContext } from '../context.js';

const customerIdArg = z.string().optional().describe('10-digit customer ID (dashes optional). Default: the configured advertiser account');
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List Google Ads accounts',
      description: 'Accounts accessible with the configured credentials, with the hierarchy under the manager account.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run(ctx, 'list_accounts', {}, async () => {
        const root = ctx.ads.loginCustomerId || ctx.ads.customerId;
        const rows = await ctx.ads.search(
          root,
          'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level, customer_client.currency_code, customer_client.time_zone, customer_client.test_account FROM customer_client',
          1000,
        );
        const accounts = rows.map((r) => {
          const c = (r.customerClient ?? {}) as Record<string, unknown>;
          return {
            id: c.id,
            name: c.descriptiveName,
            manager: c.manager ?? false,
            status: c.status,
            level: Number(c.level ?? 0),
            currency: c.currencyCode,
            time_zone: c.timeZone,
            test_account: c.testAccount ?? false,
            is_default: c.id === ctx.ads.customerId,
          };
        });
        return ok(`${accounts.length} accounts under ${root}.`, { manager_account: root, accounts });
      }),
  );

  server.registerTool(
    'run_gaql_query',
    {
      title: 'Run GAQL query (read-only)',
      description:
        'Run a read-only Google Ads Query Language (GAQL) SELECT, e.g. "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS". A LIMIT is enforced.',
      inputSchema: {
        query: z.string().min(10).max(4000),
        customer_id: customerIdArg,
        max_rows: z.number().int().min(1).max(1000).optional().describe('Default 200'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(
        ctx,
        'run_gaql_query',
        args,
        async () => {
          const maxRows = args.max_rows ?? 200;
          const query = guardGaql(args.query, maxRows);
          const customerId = await resolveCustomerId(ctx, args.customer_id);
          const rows = await ctx.ads.search(customerId, query, maxRows);
          return ok(`${rows.length} rows (amounts ending in _micros are 1/1,000,000 of the currency unit).`, {
            customer_id: customerId,
            query,
            rows,
          });
        },
        false,
      ),
  );

  server.registerTool(
    'search_terms_report',
    {
      title: 'Search terms report',
      description:
        "Real search terms that triggered your ads, with impressions, clicks, cost and conversions. Needs campaigns with traffic. Gives your own real search data on Explorer access.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('Look-back window (default 30)'),
        customer_id: customerIdArg,
        min_impressions: z.number().int().min(0).optional().describe('Default 1'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'search_terms_report', args, async () => {
        const days = args.days ?? 30;
        const end = new Date();
        const start = new Date(end.getTime() - (days - 1) * 86_400_000);
        const customerId = await resolveCustomerId(ctx, args.customer_id);
        const query = `SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr FROM search_term_view WHERE segments.date BETWEEN '${isoDate(start)}' AND '${isoDate(end)}' AND metrics.impressions >= ${args.min_impressions ?? 1} ORDER BY metrics.impressions DESC LIMIT 500`;
        const rows = await ctx.ads.search(customerId, query, 500);
        const terms = rows.map((r) => {
          const m = (r.metrics ?? {}) as Record<string, unknown>;
          return {
            search_term: (r.searchTermView as Record<string, unknown> | undefined)?.searchTerm,
            impressions: Number(m.impressions ?? 0),
            clicks: Number(m.clicks ?? 0),
            cost: microsToUnits(m.costMicros),
            conversions: Number(m.conversions ?? 0),
            ctr: Number(m.ctr ?? 0),
          };
        });
        return ok(
          terms.length ? `${terms.length} search terms in the last ${days} days.` : `No search terms in the last ${days} days (no campaign traffic yet).`,
          { customer_id: customerId, from: isoDate(start), to: isoDate(end), terms },
        );
      }),
  );

  server.registerTool(
    'api_status',
    {
      title: 'API status and diagnostics',
      description: 'Shows the configured access level, which tools are enabled, today\'s operations budget, and whether the Google credentials work.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run(
        ctx,
        'api_status',
        {},
        async () => {
          let googleAuth = 'ok';
          let accessible: number | null = null;
          try {
            await ctx.ads.getAccessToken();
            accessible = (await ctx.ads.listAccessibleCustomers()).length;
          } catch (err) {
            googleAuth = (err as Error).message;
          }
          const basic = ctx.config.GOOGLE_ADS_ACCESS_LEVEL === 'basic';
          return ok(`Access level: ${ctx.config.GOOGLE_ADS_ACCESS_LEVEL}. Google auth: ${googleAuth === 'ok' ? 'ok' : 'FAILED'}.`, {
            access_level: ctx.config.GOOGLE_ADS_ACCESS_LEVEL,
            keyword_planner_tools_enabled: basic,
            google_auth: googleAuth,
            accessible_accounts: accessible,
            default_account: `******${ctx.ads.customerId.slice(-4)}`,
            api_version: ctx.config.GOOGLE_ADS_API_VERSION,
            ops_budget: ctx.budget.usage(),
            defaults: { language: ctx.config.DEFAULT_LANGUAGE_CODE, country: ctx.config.DEFAULT_COUNTRY_CODE },
          });
        },
        false,
      ),
  );
}
