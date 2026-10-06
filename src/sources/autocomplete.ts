import { QUESTION_MODIFIERS } from '../ads/constants.js';

export type AutocompleteMode = 'plain' | 'alphabet' | 'questions' | 'all';

const ENDPOINT = 'https://suggestqueries.google.com/complete/search';
const CONCURRENCY = 4;
const PAUSE_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Google Autocomplete request. Unofficial endpoint: failures return []. */
export async function fetchSuggestions(query: string, language: string, country: string): Promise<string[]> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ client: 'firefox', hl: language, gl: country.toLowerCase(), ie: 'UTF-8', oe: 'UTF-8', q: query }).toString();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mcp-google-ads)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as [string, string[]];
    return Array.isArray(data?.[1]) ? data[1].map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Builds the list of query variants for a mode. */
export function buildVariants(query: string, mode: AutocompleteMode, language: string): string[] {
  const q = query.trim();
  const variants: string[] = [];
  if (mode === 'plain' || mode === 'all') variants.push(q);
  if (mode === 'alphabet' || mode === 'all') {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz') variants.push(`${q} ${ch}`);
  }
  if (mode === 'questions' || mode === 'all') {
    const mods = QUESTION_MODIFIERS[language] ?? QUESTION_MODIFIERS.en!;
    for (const m of mods) variants.push(`${m} ${q}`);
  }
  return [...new Set(variants)];
}

/** Runs all variants with limited concurrency; returns per-variant results and a merged list. */
export async function autocomplete(
  query: string,
  mode: AutocompleteMode,
  language: string,
  country: string,
): Promise<{ suggestions: string[]; sources: Record<string, string[]> }> {
  const variants = buildVariants(query, mode, language);
  const sources: Record<string, string[]> = {};
  for (let i = 0; i < variants.length; i += CONCURRENCY) {
    const batch = variants.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((v) => fetchSuggestions(v, language, country)));
    batch.forEach((v, idx) => (sources[v] = results[idx] ?? []));
    if (i + CONCURRENCY < variants.length) await sleep(PAUSE_MS);
  }
  const merged = [...new Set(Object.values(sources).flat().map((s) => s.toLowerCase()))].sort();
  return { suggestions: merged, sources };
}
