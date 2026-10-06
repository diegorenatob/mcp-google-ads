import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { autocomplete } from '../../sources/autocomplete.js';
import { READ_ONLY, ok, run, type ToolContext } from '../context.js';

const lang = (ctx: ToolContext) => z.string().min(2).max(5).optional().describe(`ISO-639-1 language code (default ${ctx.config.DEFAULT_LANGUAGE_CODE})`);
const country = (ctx: ToolContext) => z.string().length(2).optional().describe(`ISO-3166 country code (default ${ctx.config.DEFAULT_COUNTRY_CODE})`);

async function adsKeywordThemes(ctx: ToolContext, query: string, language: string, countryCode: string): Promise<string[]> {
  const res = await ctx.ads.call<{ keywordThemeConstants?: Array<{ displayName?: string }> }>(
    'POST',
    'keywordThemeConstants:suggest',
    { queryText: query, countryCode: countryCode.toUpperCase(), languageCode: language.toLowerCase() },
  );
  return [...new Set((res.keywordThemeConstants ?? []).map((k) => k.displayName?.trim()).filter((s): s is string => !!s))];
}

export function registerResearchTools(server: McpServer, ctx: ToolContext): void {
  const d = { language: ctx.config.DEFAULT_LANGUAGE_CODE, country: ctx.config.DEFAULT_COUNTRY_CODE };

  server.registerTool(
    'suggest_keywords',
    {
      title: 'Suggest keywords (Google Ads)',
      description:
        'Keyword suggestions from Google Ads keyword themes. Works with Explorer API access. No search volume.',
      inputSchema: {
        query: z.string().min(1).max(80).describe('Seed keyword or topic'),
        country_code: country(ctx),
        language_code: lang(ctx),
        limit: z.number().int().min(1).max(100).optional().describe('Max suggestions (default 25)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'suggest_keywords', args, async () => {
        const language = args.language_code ?? d.language;
        const countryCode = args.country_code ?? d.country;
        const all = await adsKeywordThemes(ctx, args.query, language, countryCode);
        const suggestions = all.slice(0, args.limit ?? 25);
        return ok(`${suggestions.length} keyword suggestions for "${args.query}" (${language}-${countryCode}).`, {
          query: args.query,
          language,
          country: countryCode,
          suggestions,
        });
      }),
  );

  server.registerTool(
    'autocomplete_keywords',
    {
      title: 'Google Autocomplete keywords',
      description:
        'Real searches people type, from Google Autocomplete. Modes: plain, alphabet (query + a..z), questions (how/what/... + query), all. No search volume. Unofficial source.',
      inputSchema: {
        query: z.string().min(1).max(80),
        mode: z.enum(['plain', 'alphabet', 'questions', 'all']).optional().describe('Default plain'),
        language_code: lang(ctx),
        country_code: country(ctx),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'autocomplete_keywords', args, async () => {
        const language = args.language_code ?? d.language;
        const countryCode = args.country_code ?? d.country;
        const mode = args.mode ?? 'plain';
        const { suggestions, sources } = await autocomplete(args.query, mode, language, countryCode);
        return ok(`${suggestions.length} autocomplete suggestions for "${args.query}" (mode ${mode}).`, {
          query: args.query,
          mode,
          suggestions,
          sources,
        });
      }),
  );

  server.registerTool(
    'research_keywords',
    {
      title: 'Keyword research (merged sources)',
      description:
        'One-call keyword research: Google Ads keyword themes + Google Autocomplete (+ question variants), de-duplicated and ranked by how many sources agree. Works with Explorer access. No search volume.',
      inputSchema: {
        seeds: z.array(z.string().min(1).max(80)).min(1).max(10).describe('Seed keywords'),
        country_code: country(ctx),
        language_code: lang(ctx),
        include_questions: z.boolean().optional().describe('Add question-style variants (default true)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'research_keywords', args, async () => {
        const language = args.language_code ?? d.language;
        const countryCode = args.country_code ?? d.country;
        const found = new Map<string, Set<string>>();
        const add = (kw: string, source: string) => {
          const k = kw.toLowerCase().trim();
          if (!k) return;
          if (!found.has(k)) found.set(k, new Set());
          found.get(k)!.add(source);
        };
        const warnings: string[] = [];
        for (const seed of args.seeds) {
          try {
            (await adsKeywordThemes(ctx, seed, language, countryCode)).forEach((k) => add(k, 'ads_themes'));
          } catch (err) {
            warnings.push(`ads_themes failed for "${seed}": ${(err as Error).message}`);
          }
          (await autocomplete(seed, 'plain', language, countryCode)).suggestions.forEach((k) => add(k, 'autocomplete'));
          if (args.include_questions ?? true) {
            (await autocomplete(seed, 'questions', language, countryCode)).suggestions.forEach((k) => add(k, 'questions'));
          }
        }
        const keywords = [...found.entries()]
          .map(([keyword, s]) => ({ keyword, sources: [...s].sort(), source_count: s.size }))
          .sort((a, b) => b.source_count - a.source_count || a.keyword.localeCompare(b.keyword))
          .slice(0, 300);
        return ok(`${keywords.length} unique keywords from ${args.seeds.length} seed(s). Higher source_count = stronger signal.`, {
          seeds: args.seeds,
          language,
          country: countryCode,
          keywords,
          ...(warnings.length ? { warnings } : {}),
        });
      }),
  );

  server.registerTool(
    'search_locations',
    {
      title: 'Search locations',
      description: 'Find Google Ads location (geo target) IDs by name, e.g. cities or states. Works with Explorer access.',
      inputSchema: {
        names: z.array(z.string().min(1).max(80)).min(1).max(25),
        country_code: country(ctx),
        locale: z.string().min(2).max(5).optional().describe('Language for names (default language)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(ctx, 'search_locations', args, async () => {
        type Suggestion = { geoTargetConstant?: Record<string, string> };
        const res = await ctx.ads.call<{ geoTargetConstantSuggestions?: Suggestion[] }>('POST', 'geoTargetConstants:suggest', {
          locale: args.locale ?? d.language,
          countryCode: (args.country_code ?? d.country).toUpperCase(),
          locationNames: { names: args.names },
        });
        const locations = (res.geoTargetConstantSuggestions ?? [])
          .map((s) => s.geoTargetConstant)
          .filter((g): g is Record<string, string> => !!g)
          .map((g) => ({
            id: g.id,
            name: g.name,
            canonical_name: g.canonicalName,
            target_type: g.targetType,
            country_code: g.countryCode,
            status: g.status,
          }));
        return ok(`${locations.length} locations found.`, { locations });
      }),
  );
}
