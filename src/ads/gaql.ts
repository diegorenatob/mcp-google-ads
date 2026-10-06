import { AdsError } from './errors.js';

/**
 * Accepts only a single read-only GAQL statement and enforces a row limit.
 * (GoogleAdsService.Search can't mutate anyway; this is defence in depth and
 * keeps responses small.)
 */
export function guardGaql(query: string, maxRows: number): string {
  const q = query.trim().replace(/;+\s*$/, '');
  if (!/^SELECT\s[\s\S]+?\sFROM\s+[a-z_]+/i.test(q)) {
    throw new AdsError('QUERY_REJECTED', 'Only read-only GAQL is allowed: SELECT <fields> FROM <resource> ...');
  }
  if (q.includes(';')) {
    throw new AdsError('QUERY_REJECTED', 'Only one GAQL statement is allowed.');
  }
  const limitMatch = q.match(/\bLIMIT\s+(\d+)\b/i);
  if (limitMatch) {
    const n = Math.min(Number(limitMatch[1]), maxRows);
    return q.replace(/\bLIMIT\s+\d+\b/i, `LIMIT ${n}`);
  }
  const params = q.search(/\bPARAMETERS\b/i);
  return params === -1
    ? `${q} LIMIT ${maxRows}`
    : `${q.slice(0, params).trimEnd()} LIMIT ${maxRows} ${q.slice(params)}`;
}
