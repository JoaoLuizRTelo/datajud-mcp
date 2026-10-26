import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolClient } from "../examples/agent/agent.js";
import { parseCnjNumber } from "../src/datajud/cnj-number.js";
import { resolveCourtFromCnj } from "../src/datajud/courts.js";
import { createServer } from "../src/server.js";
import { FixtureSearcher, readFixture } from "./fixture-searcher.js";
import type { EvalCase } from "./grade.js";

/** The real MCP server, in memory, answering from the case's recorded DataJud response. */
export async function toolsFor(
  evalCase: EvalCase,
): Promise<{ tools: ToolClient; close: () => Promise<void> }> {
  const court =
    evalCase.input.court ?? resolveCourtFromCnj(parseCnjNumber(evalCase.input.cnjNumber)).alias;
  const digits = parseCnjNumber(evalCase.input.cnjNumber).digits;
  const fixture = readFixture(new URL(`fixtures/${evalCase.fixture}`, import.meta.url));
  const server = createServer(new FixtureSearcher(new Map([[`${court}:${digits}`, fixture]])));
  const client = new Client({ name: "evals", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    tools: {
      listTools: () => client.listTools(),
      callTool: async (name, args) =>
        (await client.callTool({ name, arguments: args })) as CallToolResult,
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
