import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DataJudSearcher } from "../../src/datajud/client.js";
import { createServer } from "../../src/server.js";

/** Connects an MCP client to a fresh server instance in memory. */
export async function connect(datajud: DataJudSearcher) {
  const server = createServer(datajud);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  return {
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}
