import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataJudSearcher } from "./datajud/client.js";
import { registerGetCase } from "./tools/get-case.js";
import { registerListCourts } from "./tools/list-courts.js";
import { registerListMovements } from "./tools/list-movements.js";
import { registerSearchCases } from "./tools/search-cases.js";

export const SERVER_NAME = "datajud-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(
  datajud: DataJudSearcher,
  options: { progressIntervalMs?: number } = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to public metadata of Brazilian court cases via CNJ's official DataJud " +
        "API. Case numbers follow the CNJ format NNNNNNN-DD.AAAA.J.TR.OOOO. DataJud has no party " +
        "or lawyer data. Queries are slow (20-60 s), so prefer one targeted call over many.",
    },
  );
  const deps = { datajud, ...options };
  registerGetCase(server, deps);
  registerListMovements(server, deps);
  registerSearchCases(server, deps);
  registerListCourts(server);
  return server;
}
