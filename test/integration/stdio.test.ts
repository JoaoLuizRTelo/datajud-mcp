import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../helpers/fake-fetch.js";

/**
 * End-to-end: spawns the real stdio entrypoint as a child process and points it at a local HTTP
 * server that impersonates DataJud. Proves the binary wiring (env config, stdout hygiene,
 * transport) without touching the network.
 */
describe("stdio server (end to end)", () => {
  let http: Server;
  let baseUrl: string;
  const requests: { url: string; auth: string | undefined }[] = [];

  beforeAll(async () => {
    http = createServer((req, res) => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(loadFixture("trf1-case.json")));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
  });

  it("serves get_case over stdio using the configured API key", async () => {
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", entry],
      env: {
        ...(process.env as Record<string, string>),
        DATAJUD_API_KEY: "e2e-key",
        DATAJUD_BASE_URL: baseUrl,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "get_case",
        arguments: { cnjNumber: "0000832-35.2018.4.01.3202" },
      });
      expect(result.structuredContent).toMatchObject({ court: "trf1", found: true });
      expect(requests).toEqual([{ url: "/api_publica_trf1/_search", auth: "APIKey e2e-key" }]);
    } finally {
      await client.close();
    }
  }, 30_000);
});
