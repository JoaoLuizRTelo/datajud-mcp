import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { DataJudSearcher, SearchOptions } from "../../src/datajud/client.js";
import { createServer } from "../../src/server.js";

const EMPTY = { hits: { total: { value: 0, relation: "eq" }, hits: [] } };

async function connectWith(datajud: DataJudSearcher) {
  const server = createServer(datajud, { progressIntervalMs: 20 });
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe("long-running tool calls", () => {
  it("sends progress heartbeats that keep a short client timeout alive", async () => {
    const slow: DataJudSearcher = {
      search: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve(EMPTY);
          }, 300),
        ),
    };
    const client = await connectWith(slow);
    const progress: string[] = [];

    const result = await client.callTool(
      { name: "get_case", arguments: { cnjNumber: "0000832-35.2018.4.01.3202" } },
      undefined,
      {
        timeout: 150, // would expire without heartbeats
        resetTimeoutOnProgress: true,
        onprogress: (p) => progress.push(p.message ?? ""),
      },
    );

    expect(result.structuredContent).toMatchObject({ found: false });
    expect(progress.length).toBeGreaterThan(3);
    expect(progress[0]).toMatch(/Waiting for DataJud/);
    await client.close();
  });

  it("propagates client cancellation to the DataJud request", async () => {
    let received: AbortSignal | undefined;
    const hanging: DataJudSearcher = {
      search: (_court, _body, options?: SearchOptions) => {
        received = options?.signal;
        return new Promise(() => undefined);
      },
    };
    const client = await connectWith(hanging);
    const controller = new AbortController();
    const call = client.callTool(
      { name: "get_case", arguments: { cnjNumber: "0000832-35.2018.4.01.3202" } },
      undefined,
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received?.aborted).toBe(true);
    await client.close();
  });
});
