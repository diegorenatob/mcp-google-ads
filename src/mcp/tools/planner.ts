import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { countryGeoResource, languageResource } from '../../ads/constants.js';
import { READ_ONLY, microsToUnits, ok, run, type ToolContext } from '../context.js';

/**
 * Keyword Planner tools. Google allows these methods only with Basic (or
 * Standard) access, so they are registered only when GOOGLE_ADS_ACCESS_LEVEL=basic.
 * Request shapes follow the v23 REST reference; responses could not be verified
 * live while the project had Explorer access.
 */
export function registerPlannerTools(server: McpServer, ctx: ToolContext): void {
  const targeting = {
    country_code: z.string().length(2).optional().describe(`ISO-3166 country (default ${ctx.config.DEFAULT_COUNTRY_CODE}); ignored if location_ids given`),
    location_ids: z.array(z.string().regex(/^\d+$/)).max(10).optional().describe('Geo target IDs from search_locations'),
    language_code: z.string().min(2).max(5).optional().describe(`Default ${ctx.config.DEFAULT_LANGUAGE_CODE}`),
  };
  const geo = (a: { country_code?: string; location_ids?: string[] }) =>
    a.location_ids?.length ? a.location_ids.map((id) => `geoTargetConstants/${id}`) : [countryGeoResource(a.country_code ?? ctx.config.DEFAULT_COUNTRY_CODE)];
  const language = (code?: string) => languageResource(code ?? ctx.config.DEFAULT_LANGUAGE_CODE);
  const cid = ctx.ads.customerId;

  type Metrics = Record<string, unknown> & { monthlySearchVolumes?: Array<Record<string, unknown>> };
  const shapeMetrics = (m: Metrics = {}) => ({
    avg_monthly_searches: m.avgMonthlySearches !== undefined ? Number(m.avgMonthlySearches) : null,
    competition: m.competition ?? null,
    competition_index: m.competitionIndex !== undefined ? Number(m.competitionIndex) : null,
    low_top_of_page_bid: microsToUnits(m.lowTopOfPageBidMicros),
    high_top_of_page_bid: microsToUnits(m.highTopOfPageBidMicros),
  });

  server.registerTool(
    'keyword_ideas',
    {
      title: 'Keyword ideas with volume (Basic access)',
      description: 'Keyword Planner ideas with average monthly searches, competition and top-of-page bids. Requires Basic API access.',
      inputSchema: {
        seeds: z.array(z.string().min(1).max(80)).max(20).optional(),
        url: z.string().url().optional().describe('Page or site to extract ideas from'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
        ...targeting,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'keyword_ideas', args, async () => {
        if (!args.seeds?.length && !args.url) throw new Error('Provide seeds and/or url.');
        const seed = args.seeds?.length && args.url
          ? { keywordAndUrlSeed: { url: args.url, keywords: args.seeds } }
          : args.url ? { urlSeed: { url: args.url } } : { keywordSeed: { keywords: args.seeds } };
        const res = await ctx.ads.call<{ results?: Array<{ text?: string; keywordIdeaMetrics?: Metrics }> }>(
          'POST',
          `customers/${cid}:generateKeywordIdeas`,
          {
            language: language(args.language_code),
            geoTargetConstants: geo(args),
            keywordPlanNetwork: 'GOOGLE_SEARCH',
            includeAdultKeywords: false,
            pageSize: args.limit ?? 50,
            ...seed,
          },
        );
        const ideas = (res.results ?? []).slice(0, args.limit ?? 50).map((r) => ({ keyword: r.text, ...shapeMetrics(r.keywordIdeaMetrics) }));
        return ok(`${ideas.length} keyword ideas (bids in account currency).`, { ideas });
      }),
  );

  server.registerTool(
    'keyword_metrics',
    {
      title: 'Historical keyword metrics (Basic access)',
      description: 'Average monthly searches, competition, bids and 12-month volume history for specific keywords. Requires Basic API access.',
      inputSchema: { keywords: z.array(z.string().min(1).max(80)).min(1).max(50), ...targeting },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'keyword_metrics', args, async () => {
        const res = await ctx.ads.call<{ results?: Array<{ text?: string; keywordMetrics?: Metrics }> }>(
          'POST',
          `customers/${cid}:generateKeywordHistoricalMetrics`,
          { keywords: args.keywords, language: language(args.language_code), geoTargetConstants: geo(args), keywordPlanNetwork: 'GOOGLE_SEARCH' },
        );
        const metrics = (res.results ?? []).map((r) => ({
          keyword: r.text,
          ...shapeMetrics(r.keywordMetrics),
          monthly_search_volumes: (r.keywordMetrics?.monthlySearchVolumes ?? []).map((v) => ({
            year: Number(v.year),
            month: v.month,
            searches: Number(v.monthlySearches ?? 0),
          })),
        }));
        return ok(`Metrics for ${metrics.length} keywords.`, { metrics });
      }),
  );

  server.registerTool(
    'keyword_forecast',
    {
      title: 'Keyword forecast (Basic access)',
      description: 'Projected impressions, clicks, cost and CTR for a set of keywords at a max CPC. Requires Basic API access.',
      inputSchema: {
        keywords: z.array(z.string().min(1).max(80)).min(1).max(50),
        max_cpc: z.number().positive().describe('Max CPC bid in account currency, e.g. 1.5'),
        match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).optional().describe('Default PHRASE'),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Default tomorrow'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Default start + 30 days'),
        ...targeting,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'keyword_forecast', args, async () => {
        const start = args.start_date ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        const end = args.end_date ?? new Date(Date.parse(start) + 30 * 86_400_000).toISOString().slice(0, 10);
        const res = await ctx.ads.call<{ campaignForecastMetrics?: Record<string, unknown> }>(
          'POST',
          `customers/${cid}:generateKeywordForecastMetrics`,
          {
            campaign: {
              keywordPlanNetwork: 'GOOGLE_SEARCH',
              biddingStrategy: { manualCpcBiddingStrategy: { maxCpcBidMicros: String(Math.round(args.max_cpc * 1_000_000)) } },
              adGroups: [{ biddableKeywords: args.keywords.map((text) => ({ keyword: { text, matchType: args.match_type ?? 'PHRASE' } })) }],
              geoModifiers: geo(args).map((g) => ({ geoTargetConstant: g })),
              languageConstants: [language(args.language_code)],
            },
            forecastPeriod: { startDate: start, endDate: end },
          },
        );
        const m = res.campaignForecastMetrics ?? {};
        return ok(`Forecast ${start} → ${end}.`, {
          start_date: start,
          end_date: end,
          impressions: m.impressions !== undefined ? Number(m.impressions) : null,
          clicks: m.clicks !== undefined ? Number(m.clicks) : null,
          cost: microsToUnits(m.costMicros),
          ctr: m.clickThroughRate !== undefined ? Number(m.clickThroughRate) : null,
          average_cpc: microsToUnits(m.averageCpcMicros),
          conversions: m.conversions !== undefined ? Number(m.conversions) : null,
        });
      }),
  );
}
