import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerPlannerTools } from './tools/planner.js';
import { registerResearchTools } from './tools/research.js';

export const SERVER_NAME = 'mcp-google-ads';
export const SERVER_VERSION = '0.1.0';

/** Builds a fresh MCP server (stateless transport: one per request). */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only Google Ads research tools. Start with research_keywords for keyword ideas; use search_locations for geo IDs; run_gaql_query and search_terms_report for account data. ' +
        (ctx.config.GOOGLE_ADS_ACCESS_LEVEL === 'basic'
          ? 'keyword_ideas, keyword_metrics and keyword_forecast provide search volumes and bids.'
          : 'Search volumes are not available on Explorer API access; keyword_ideas/keyword_metrics/keyword_forecast are disabled.'),
    },
  );
  registerResearchTools(server, ctx);
  registerAccountTools(server, ctx);
  if (ctx.config.GOOGLE_ADS_ACCESS_LEVEL === 'basic') registerPlannerTools(server, ctx);
  return server;
}
