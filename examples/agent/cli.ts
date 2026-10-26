/**
 * Summarize a court case with Claude, using the DataJud MCP server as its only tool source.
 *
 *   npm run agent -- 0713383-43.2025.8.07.0006
 *   npm run agent -- 1035289-48.2022.8.26.0602 --court stj
 *   npm run agent -- 0713383-43.2025.8.07.0006 --force     # ignore the pre-check
 *
 * stdout: one JSON document. stderr: progress logs.
 * Exit codes: 0 summary or skipped, 1 error, 2 agent did not converge.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  AgentDidNotConvergeError,
  anthropicModelClient,
  DEFAULT_AGENT_OPTIONS,
  mcpToolClient,
} from "./agent.js";
import { monitorCase } from "./monitor.js";
import { StateStore } from "./precheck.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = z
  .object({
    ANTHROPIC_MODEL: z.string().default(DEFAULT_AGENT_OPTIONS.model),
    ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(6),
  })
  .parse(process.env);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    court: { type: "string" },
    force: { type: "boolean", default: false },
    "state-dir": { type: "string", default: ".datajud-state" },
  },
});
const cnjNumber = positionals[0];
if (!cnjNumber) {
  console.error("Usage: npm run agent -- <cnj-number> [--court <alias>] [--force]");
  process.exit(1);
}

const log = (message: string): void => {
  console.error(message);
};
const print = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

const serverEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const mcp = new Client({ name: "datajud-agent", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", serverEntry],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);

let exitCode = 0;
try {
  const result = await monitorCase(
    { cnjNumber, court: values.court },
    {
      model: anthropicModelClient(new Anthropic()),
      tools: mcpToolClient(mcp, log),
      store: new StateStore(values["state-dir"]),
    },
    {
      ...DEFAULT_AGENT_OPTIONS,
      model: env.ANTHROPIC_MODEL,
      effort: env.ANTHROPIC_EFFORT,
      maxIterations: env.AGENT_MAX_ITERATIONS,
      asOf: new Date(),
      force: values.force,
      log,
    },
  );
  print(
    result.skipped
      ? { ...result, tokensSpent: 0 }
      : {
          skipped: false,
          summary: result.summary,
          meta: {
            model: env.ANTHROPIC_MODEL,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            usage: result.usage,
          },
        },
  );
} catch (error) {
  exitCode = error instanceof AgentDidNotConvergeError ? 2 : 1;
  log(`[error] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await mcp.close();
}
process.exit(exitCode);
