import { QUESTION_MODIFIERS } from '../ads/constants.js';

export type AutocompleteMode = 'plain' | 'alphabet' | 'questions' | 'all';

const ENDPOINT = 'https://suggestqueries.google.com/complete/search';
const CONCURRENCY = 4;
const PAUSE_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "in" preposition per language, used to build "<query> in <place>" variants. */
const PLACE_PREPOSITION: Record<string, string> = { pt: 'em', es: 'en', en: 'in' };

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

/** Query variants that bias the search toward specific places: "<q> <place>" and "<q> em <place>". */
export function localVariants(query: string, locations: readonly string[], language: string): string[] {
  const q = query.trim();
  const prep = PLACE_PREPOSITION[language];
  const variants: string[] = [];
  for (const raw of locations) {
    const place = raw.trim();
    if (!place) continue;
    variants.push(`${q} ${place}`);
    if (prep) variants.push(`${q} ${prep} ${place}`);
  }
  return [...new Set(variants)];
}

/** Builds the list of query variants for a mode, plus optional local (place) variants. */
export function buildVariants(
  query: string,
  mode: AutocompleteMode,
  language: string,
  locations: readonly string[] = [],
): string[] {
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
  variants.push(...localVariants(q, locations, language));
  return [...new Set(variants)];
}

/** Runs query variants with limited concurrency; returns per-variant results and a merged list. */
export async function runVariants(
  variants: readonly string[],
  language: string,
  country: string,
): Promise<{ suggestions: string[]; sources: Record<string, string[]> }> {
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

export function autocomplete(
  query: string,
  mode: AutocompleteMode,
  language: string,
  country: string,
  locations: readonly string[] = [],
) {
  return runVariants(buildVariants(query, mode, language, locations), language, country);
}

/** Only the place-biased variants (no plain/alphabet/question variants). */
export function autocompleteLocal(query: string, locations: readonly string[], language: string, country: string) {
  return runVariants(localVariants(query, locations, language), language, country);
}

/** Lower-case, accent-free form used to match place names inside keywords. */
export const normalizeText = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
