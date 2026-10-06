import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdsError } from '../../ads/errors.js';
import { normalizeAdAccountId, type MetaClient } from '../../meta/client.js';
import { READ_ONLY, ok, run, type ToolContext } from '../context.js';

/**
 * Interest sets verified against targetingsearch (pt_BR). Meta has no interests for
 * labour law, unemployment insurance or similar topics; these are the closest proxies.
 */
export const INTEREST_PRESETS: Record<string, { label: string; interests: Array<{ id: string; name: string }> }> = {
  job_seekers: {
    label: 'Job seekers (job search, job boards, Indeed, LinkedIn)',
    interests: [
      { id: '6004037215009', name: 'Busca de emprego (carreiras)' },
      { id: '6003142845761', name: 'Emprego (carreiras)' },
      { id: '6815667873117', name: 'Carreiras e anúncios de vaga de emprego (emprego)' },
      { id: '6003074500597', name: 'Indeed.com' },
      { id: '6003246495067', name: 'LinkedIn' },
    ],
  },
  self_employed: {
    label: 'Self-employed and freelancers',
    interests: [
      { id: '6003374632277', name: 'Freelancer (carreiras)' },
      { id: '6003214937861', name: 'Trabalho autônomo (carreiras)' },
    ],
  },
};

const OPTIMIZATION_GOALS = ['LEAD_GENERATION', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS', 'LANDING_PAGE_VIEWS', 'OFFSITE_CONVERSIONS'] as const;
const MAX_MATRIX_ESTIMATES = 60;

const adAccountArg = z.string().optional().describe('Meta ad account ID (act_ prefix optional). Default: META_AD_ACCOUNT_ID, else the first account the token can see');
const geoArg = z
  .object({
    countries: z.array(z.string().length(2)).max(25).optional().describe('ISO-3166 country codes, e.g. ["BR"]'),
    regions: z.array(z.string().regex(/^\d+$/)).max(50).optional().describe('Region keys from meta_search_locations'),
    cities: z.array(z.string().regex(/^\d+$/)).max(50).optional().describe('City keys from meta_search_locations'),
  })
  .describe('Where to target. At least one of countries, regions or cities.');
const excludedRegionsArg = z.array(z.string().regex(/^\d+$/)).max(50).optional().describe('Region keys to exclude, e.g. São Paulo inside BR');
const ageMin = z.number().int().min(18).max(65).optional().describe('Default 18');
const ageMax = z.number().int().min(18).max(65).optional().describe('Default 65 (65 = 65+)');
const goalArg = z.enum(OPTIMIZATION_GOALS).optional().describe('Default LEAD_GENERATION');

type Geo = z.infer<typeof geoArg>;

interface AdAccount {
  id: string;
  account_id: string;
  name?: string;
  account_status?: number;
  currency?: string;
}

function meta(ctx: ToolContext): MetaClient {
  if (!ctx.meta) throw new AdsError('META_DISABLED', 'Meta tools are disabled: META_ACCESS_TOKEN is not set.');
  return ctx.meta;
}

async function adAccounts(ctx: ToolContext): Promise<AdAccount[]> {
  const cached = ctx.cache.get('__meta_ad_accounts') as AdAccount[] | undefined;
  if (cached) return cached;
  const res = await meta(ctx).get<{ data?: AdAccount[] }>('me/adaccounts', { fields: 'account_id,name,account_status,currency', limit: 100 });
  const list = res.data ?? [];
  ctx.cache.set('__meta_ad_accounts', list);
  return list;
}

/** Resolves the ad account to use and checks the token can see it. */
export async function resolveAdAccount(ctx: ToolContext, input?: string): Promise<string> {
  const wanted = normalizeAdAccountId(input ?? '') || meta(ctx).defaultAdAccountId;
  const visible = await adAccounts(ctx);
  if (!wanted) {
    const first = visible.at(0);
    if (!first) throw new AdsError('META_NO_AD_ACCOUNT', 'The Meta token cannot see any ad account.');
    return first.account_id;
  }
  if (!visible.some((a) => a.account_id === wanted)) {
    throw new AdsError('META_AD_ACCOUNT_NOT_ALLOWED', `Ad account ${wanted} is not accessible with this Meta token. Use meta_status to list the visible ones.`);
  }
  return wanted;
}

/** Builds a Meta targeting_spec from tool arguments. */
export function buildTargeting(opts: {
  geo: Geo;
  excludedRegions?: string[];
  ageMin?: number;
  ageMax?: number;
  interestIds?: string[];
}): Record<string, unknown> {
  const { geo } = opts;
  if (!geo.countries?.length && !geo.regions?.length && !geo.cities?.length) {
    throw new AdsError('META_BAD_GEO', 'geo needs at least one of countries, regions or cities.');
  }
  const geoLocations: Record<string, unknown> = {};
  if (geo.countries?.length) geoLocations.countries = geo.countries.map((c) => c.toUpperCase());
  if (geo.regions?.length) geoLocations.regions = geo.regions.map((key) => ({ key }));
  if (geo.cities?.length) geoLocations.cities = geo.cities.map((key) => ({ key }));
  const ageMin = opts.ageMin ?? 18;
  const ageMax = opts.ageMax ?? 65;
  if (ageMin > ageMax) throw new AdsError('META_BAD_AGE', 'age_min must not exceed age_max.');
  const spec: Record<string, unknown> = { geo_locations: geoLocations, age_min: ageMin, age_max: ageMax };
  if (opts.excludedRegions?.length) spec.excluded_geo_locations = { regions: opts.excludedRegions.map((key) => ({ key })) };
  if (opts.interestIds?.length) spec.flexible_spec = [{ interests: opts.interestIds.map((id) => ({ id })) }];
  return spec;
}

async function estimate(ctx: ToolContext, account: string, targeting: Record<string, unknown>, goal: string) {
  const res = await meta(ctx).get<{ data?: Array<Record<string, unknown>> }>(`act_${account}/delivery_estimate`, {
    targeting_spec: targeting,
    optimization_goal: goal,
  });
  const d = res.data?.at(0) ?? {};
  return {
    audience_min: (d.estimate_mau_lower_bound as number | undefined) ?? null,
    audience_max: (d.estimate_mau_upper_bound as number | undefined) ?? null,
    ready: (d.estimate_ready as boolean | undefined) ?? null,
  };
}

const fmt = (n: number | null) => (n === null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'meta_status',
    {
      title: 'Meta token status',
      description: 'Checks the Meta access token: whether it is valid, when it expires, its permissions, and which ad accounts it can see.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run(
        ctx,
        'meta_status',
        {},
        async () => {
          const client = meta(ctx);
          const dbg = await client.get<{ data?: Record<string, unknown> }>('debug_token', { input_token: ctx.config.META_ACCESS_TOKEN });
          const d = dbg.data ?? {};
          const expiresAt = Number(d.expires_at ?? 0);
          const accounts = await adAccounts(ctx);
          return ok(`Meta token ${d.is_valid ? 'valid' : 'INVALID'}; ${accounts.length} ad account(s) visible.`, {
            valid: Boolean(d.is_valid),
            app: d.application ?? null,
            type: d.type ?? null,
            scopes: d.scopes ?? [],
            expires_at: expiresAt > 0 ? new Date(expiresAt * 1000).toISOString() : 'never',
            default_ad_account: client.defaultAdAccountId || null,
            api_version: ctx.config.META_API_VERSION,
            ad_accounts: accounts.map((a) => ({ id: a.account_id, name: a.name, status: a.account_status, currency: a.currency })),
            interest_presets: Object.fromEntries(Object.entries(INTEREST_PRESETS).map(([k, v]) => [k, v.label])),
          });
        },
        false,
      ),
  );

  server.registerTool(
    'meta_search_locations',
    {
      title: 'Search Meta locations',
      description: 'Finds Meta targeting keys for regions (states), cities or countries. Names may come back localized (e.g. "Río Grande del Sur").',
      inputSchema: {
        query: z.string().min(2).max(80),
        location_types: z.array(z.enum(['country', 'region', 'city', 'zip'])).min(1).max(4).optional().describe('Default ["region", "city"]'),
        country_code: z.string().length(2).optional().describe(`ISO-3166 country code (default ${ctx.config.DEFAULT_COUNTRY_CODE})`),
        limit: z.number().int().min(1).max(50).optional().describe('Default 10'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'meta_search_locations', args, async () => {
        const res = await meta(ctx).get<{ data?: Array<Record<string, unknown>> }>('search', {
          type: 'adgeolocation',
          q: args.query,
          location_types: args.location_types ?? ['region', 'city'],
          country_code: (args.country_code ?? ctx.config.DEFAULT_COUNTRY_CODE).toUpperCase(),
          locale: 'pt_BR',
          limit: args.limit ?? 10,
        });
        const locations = (res.data ?? []).map((l) => ({
          key: l.key,
          name: l.name,
          type: l.type,
          region: l.region ?? null,
          country_code: l.country_code,
        }));
        return ok(`${locations.length} locations for "${args.query}".`, { locations });
      }),
  );

  server.registerTool(
    'meta_search_interests',
    {
      title: 'Search Meta interests',
      description:
        'Finds Meta detailed-targeting interests and their global audience size. Many topics (e.g. labour law, unemployment insurance) have no interest at all; try English terms and broader topics. See interest_presets in meta_status for verified sets.',
      inputSchema: {
        query: z.string().min(2).max(80),
        locale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/).optional().describe('Default pt_BR'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 10'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'meta_search_interests', args, async () => {
        const res = await meta(ctx).get<{ data?: Array<Record<string, unknown>> }>('search', {
          type: 'adinterest',
          q: args.query,
          locale: args.locale ?? 'pt_BR',
          limit: args.limit ?? 10,
        });
        const interests = (res.data ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          audience_min: i.audience_size_lower_bound ?? null,
          audience_max: i.audience_size_upper_bound ?? null,
          path: i.path ?? null,
          topic: i.topic ?? null,
        }));
        return ok(
          interests.length ? `${interests.length} interests for "${args.query}".` : `No Meta interest matches "${args.query}". Try English or a broader topic.`,
          { interests },
        );
      }),
  );

  server.registerTool(
    'meta_audience_size',
    {
      title: 'Meta audience size',
      description:
        'Estimated monthly active audience for one targeting (geo, age, optional interests ORed together). Read-only: nothing is created. Meta no longer returns cost or result estimates through the API.',
      inputSchema: {
        geo: geoArg,
        excluded_regions: excludedRegionsArg,
        age_min: ageMin,
        age_max: ageMax,
        interest_ids: z.array(z.string().regex(/^\d+$/)).max(50).optional().describe('Interest IDs (ORed). Omit for no interest filter'),
        interest_preset: z.enum(Object.keys(INTEREST_PRESETS) as [string, ...string[]]).optional().describe('Use a verified interest set instead of interest_ids'),
        optimization_goal: goalArg,
        ad_account_id: adAccountArg,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'meta_audience_size', args, async () => {
        const account = await resolveAdAccount(ctx, args.ad_account_id);
        const interestIds = args.interest_preset ? INTEREST_PRESETS[args.interest_preset]!.interests.map((i) => i.id) : args.interest_ids;
        const targeting = buildTargeting({
          geo: args.geo,
          excludedRegions: args.excluded_regions,
          ageMin: args.age_min,
          ageMax: args.age_max,
          interestIds,
        });
        const est = await estimate(ctx, account, targeting, args.optimization_goal ?? 'LEAD_GENERATION');
        return ok(`Estimated audience: ${fmt(est.audience_min)}–${fmt(est.audience_max)} monthly active people.`, {
          ad_account_id: account,
          targeting,
          ...est,
        });
      }),
  );

  server.registerTool(
    'meta_audience_matrix',
    {
      title: 'Meta audience matrix',
      description: `Crosses several geos with several interest sets and estimates the monthly audience of each cell (max ${MAX_MATRIX_ESTIMATES} cells). Default interest sets: the verified presets. Returns rows plus CSV.`,
      inputSchema: {
        geos: z
          .array(z.object({ label: z.string().min(1).max(40), geo: geoArg, excluded_regions: excludedRegionsArg }))
          .min(1)
          .max(10),
        interest_sets: z
          .array(z.object({ label: z.string().min(1).max(60), interest_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(50) }))
          .max(20)
          .optional()
          .describe('Default: every entry of interest_presets'),
        include_no_interest: z.boolean().optional().describe('Add a baseline column with no interest filter (default true)'),
        age_min: ageMin,
        age_max: ageMax,
        optimization_goal: goalArg,
        ad_account_id: adAccountArg,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'meta_audience_matrix', args, async () => {
        const account = await resolveAdAccount(ctx, args.ad_account_id);
        const sets: Array<{ label: string; ids?: string[] }> = [];
        if (args.include_no_interest ?? true) sets.push({ label: '(no interest)' });
        const chosen =
          args.interest_sets ??
          Object.values(INTEREST_PRESETS).map((p) => ({ label: p.label, interest_ids: p.interests.map((i) => i.id) }));
        for (const s of chosen) sets.push({ label: s.label, ids: s.interest_ids });
        const cells = args.geos.length * sets.length;
        if (cells > MAX_MATRIX_ESTIMATES) {
          throw new AdsError('META_MATRIX_TOO_LARGE', `${cells} cells requested; the limit is ${MAX_MATRIX_ESTIMATES}.`);
        }
        const goal = args.optimization_goal ?? 'LEAD_GENERATION';
        const rows: Array<Record<string, unknown>> = [];
        for (const g of args.geos) {
          for (const s of sets) {
            const targeting = buildTargeting({
              geo: g.geo,
              excludedRegions: g.excluded_regions,
              ageMin: args.age_min,
              ageMax: args.age_max,
              interestIds: s.ids,
            });
            rows.push({ geo: g.label, interests: s.label, ...(await estimate(ctx, account, targeting, goal)) });
          }
        }
        const csvCell = (v: unknown) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v ?? ''));
        const csv = ['geo,interests,audience_min,audience_max,ready', ...rows.map((r) => [r.geo, r.interests, r.audience_min, r.audience_max, r.ready].map(csvCell).join(','))].join('\n');
        return ok(`${rows.length} audience estimates (${args.geos.length} geos × ${sets.length} interest sets).`, {
          ad_account_id: account,
          age: { min: args.age_min ?? 18, max: args.age_max ?? 65 },
          rows,
          csv,
        });
      }),
  );

  server.registerTool(
    'meta_campaign_insights',
    {
      title: 'Meta campaign insights',
      description: 'Spend, reach, clicks, leads and cost per result from Meta Ads reporting, by account, campaign, ad set or ad.',
      inputSchema: {
        date_preset: z
          .enum(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month', 'maximum'])
          .optional()
          .describe('Default last_30d'),
        level: z.enum(['account', 'campaign', 'adset', 'ad']).optional().describe('Default campaign'),
        ad_account_id: adAccountArg,
        limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(
        ctx,
        'meta_campaign_insights',
        args,
        async () => {
          const account = await resolveAdAccount(ctx, args.ad_account_id);
          const level = args.level ?? 'campaign';
          const res = await meta(ctx).get<{ data?: Array<Record<string, unknown>> }>(`act_${account}/insights`, {
            level,
            date_preset: args.date_preset ?? 'last_30d',
            fields: 'campaign_name,adset_name,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpm,actions,cost_per_action_type',
            limit: args.limit ?? 100,
          });
          const rows = res.data ?? [];
          return ok(rows.length ? `${rows.length} ${level} rows.` : 'No delivery in this period (no active campaigns yet).', {
            ad_account_id: account,
            level,
            date_preset: args.date_preset ?? 'last_30d',
            rows,
          });
        },
        false,
      ),
  );
}
