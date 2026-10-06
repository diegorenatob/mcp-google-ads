import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GoogleAdsClient } from '../ads/client.js';
import type { OpsBudget } from '../ads/budget.js';
import { AdsError } from '../ads/errors.js';
import type { Config } from '../config.js';
import type { MetaClient } from '../meta/client.js';
import type { TtlCache } from '../util/cache.js';
import type { Logger } from '../util/logger.js';

export interface ToolContext {
  config: Config;
  ads: GoogleAdsClient;
  /** Present when META_ACCESS_TOKEN is set. */
  meta?: MetaClient;
  budget: OpsBudget;
  cache: TtlCache<unknown>;
  logger: Logger;
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Successful result: short human summary + JSON for the model. */
export function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

/** Error result with a safe, actionable message (never stack traces or secrets). */
export function fail(err: unknown, logger: Logger, tool: string): CallToolResult {
  const message =
    err instanceof AdsError ? err.message : err instanceof Error ? err.message : 'Unexpected error.';
  if (!(err instanceof AdsError)) logger.error('tool failed', { tool, error: String(err) });
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wraps a handler with caching and error handling. */
export async function run(
  ctx: ToolContext,
  tool: string,
  args: unknown,
  handler: () => Promise<CallToolResult>,
  cacheable = true,
): Promise<CallToolResult> {
  const key = `${tool}:${JSON.stringify(args)}`;
  try {
    if (!cacheable) return await handler();
    const cached = ctx.cache.get(key) as CallToolResult | undefined;
    if (cached) return cached;
    const result = await handler();
    if (!result.isError) ctx.cache.set(key, result);
    return result;
  } catch (err) {
    return fail(err, ctx.logger, tool);
  }
}

const microsToUnits = (m: unknown) => (m === undefined || m === null ? null : Math.round(Number(m) / 10_000) / 100);
export { microsToUnits };

/** Account IDs this server may query: the configured allowlist, or else accessible accounts + everything under the MCC. */
export async function allowedCustomerIds(ctx: ToolContext): Promise<Set<string>> {
  const configured = ctx.config.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS;
  if (configured.length > 0) return new Set([...configured, ctx.ads.customerId]);
  const cached = ctx.cache.get('__allowed_ids') as string[] | undefined;
  if (cached) return new Set(cached);
  const ids = new Set(await ctx.ads.listAccessibleCustomers());
  const root = ctx.ads.loginCustomerId || ctx.ads.customerId;
  const rows = await ctx.ads.search(root, 'SELECT customer_client.id FROM customer_client', 1000);
  for (const r of rows) {
    const id = (r.customerClient as { id?: string } | undefined)?.id;
    if (id) ids.add(String(id));
  }
  ids.add(ctx.ads.customerId);
  ctx.cache.set('__allowed_ids', [...ids]);
  return ids;
}

export async function resolveCustomerId(ctx: ToolContext, input?: string): Promise<string> {
  if (!input) return ctx.ads.customerId;
  const id = input.replace(/-/g, '').trim();
  if (!/^\d{10}$/.test(id)) throw new AdsError('BAD_CUSTOMER_ID', 'customer_id must be 10 digits (dashes optional).');
  if (!(await allowedCustomerIds(ctx)).has(id)) {
    throw new AdsError('CUSTOMER_NOT_ALLOWED', `Account ${id} is not accessible with these credentials. Use list_accounts.`);
  }
  return id;
}
