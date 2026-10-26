import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDidNotConvergeError,
  AgentError,
  DEFAULT_AGENT_OPTIONS,
  runAgent,
  type ToolClient,
} from "../../examples/agent/agent.js";
import { monitorCase } from "../../examples/agent/monitor.js";
import type { CaseSummary } from "../../examples/agent/output-schema.js";
import { StateStore } from "../../examples/agent/precheck.js";
import { FixtureSearcher, readFixture } from "../../evals/fixture-searcher.js";
import type { RawSearchResponse } from "../../src/datajud/schemas.js";
import { connect } from "../helpers/mcp.js";
import { scriptedModel } from "../helpers/scripted-model.js";

const CASE = "0713383-43.2025.8.07.0006";
const fixture = readFixture(
  new URL("../../evals/fixtures/tjdft-judgment-granted.json", import.meta.url),
);

const summary: CaseSummary = {
  cnjNumber: CASE,
  court: "tjdft",
  found: true,
  currentStatus: "A conviction was issued on 2026-10-08.",
  statusCategory: "decided",
  lastRelevantMovements: [
    { date: "2026-10-08", instance: "G1", name: "Procedência", whyRelevant: "Judgment issued" },
  ],
  needsLawyerAttention: true,
  attentionReasons: ["Recent judgment may open an appeal deadline"],
  confidence: "high",
};

const options = { ...DEFAULT_AGENT_OPTIONS, asOf: new Date("2026-10-26T00:00:00Z") };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Real MCP server (in memory) backed by recorded DataJud responses. */
async function mcpTools(
  data: RawSearchResponse = fixture,
): Promise<ToolClient & { calls: string[] }> {
  const searcher = new FixtureSearcher(new Map([["tjdft:07133834320258070006", data]]));
  const session = await connect(searcher);
  cleanups.push(session.close);
  const calls: string[] = [];
  return {
    calls,
    listTools: () => session.client.listTools(),
    callTool: (name, args) => {
      calls.push(name);
      return session.call(name, args);
    },
  };
}

describe("runAgent", () => {
  it("bridges MCP tools to Claude and returns a validated summary", async () => {
    const tools = await mcpTools();
    const model = scriptedModel([
      { toolUses: [{ name: "get_case", input: { cnjNumber: CASE } }] },
      { toolUses: [{ name: "list_movements", input: { cnjNumber: CASE, limit: 10 } }] },
      { final: summary },
    ]);

    const result = await runAgent({ cnjNumber: CASE }, { model, tools }, options);

    expect(result.summary).toEqual(summary);
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toEqual(["get_case", "list_movements"]);
    expect(result.usage).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadInputTokens: 150,
      cacheCreationInputTokens: 30,
    });

    // The model saw the real tool output from the MCP server.
    const lastRequest = JSON.stringify(model.requests[2]!.messages);
    expect(lastRequest).toContain("Procedência");
    expect(lastRequest).toContain("conviction");
  });

  it("sends the expected request shape", async () => {
    const tools = await mcpTools();
    const model = scriptedModel([{ final: summary }]);
    await runAgent({ cnjNumber: CASE, court: "tjdft" }, { model, tools }, options);

    const request = model.requests[0]!;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.tools?.map((t) => ("name" in t ? t.name : "")).sort()).toEqual([
      "get_case",
      "list_courts",
      "list_movements",
      "search_cases",
    ]);
    expect(request.output_config?.effort).toBe("medium");
    expect(request.output_config?.format?.type).toBe("json_schema");
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toContain("server-side-fallback-2026-07-01");
    expect(request.messages[0]!.content).toBe(
      `Today is 2026-10-26. Summarize case ${CASE} in court "tjdft".`,
    );
  });

  it("answers parallel tool calls in a single user turn", async () => {
    const tools = await mcpTools();
    const model = scriptedModel([
      {
        toolUses: [
          { name: "get_case", input: { cnjNumber: CASE } },
          { name: "list_movements", input: { cnjNumber: CASE } },
        ],
      },
      { final: summary },
    ]);
    await runAgent({ cnjNumber: CASE }, { model, tools }, options);

    const toolTurn = model.requests[1]!.messages.at(-1)!;
    expect(toolTurn.role).toBe("user");
    expect(toolTurn.content).toHaveLength(2);
  });

  it("returns tool errors to the model instead of crashing", async () => {
    const tools = await mcpTools();
    const model = scriptedModel([
      {
        toolUses: [
          { name: "get_case", input: { cnjNumber: "0713383-44.2025.8.07.0006" } },
          { name: "delete_everything", input: {} },
        ],
      },
      { final: summary },
    ]);
    await runAgent({ cnjNumber: CASE }, { model, tools }, options);

    const results = model.requests[1]!.messages.at(-1)!.content as {
      is_error: boolean;
      content: string;
    }[];
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]!.content).toMatch(/check digits/);
    expect(results[1]).toMatchObject({
      is_error: true,
      content: "Unknown tool delete_everything.",
    });
    expect(tools.calls).toEqual(["get_case"]);
  });

  it("fails clearly when the loop does not converge", async () => {
    const tools = await mcpTools();
    const looping = Array.from({ length: 10 }, () => ({
      toolUses: [{ name: "list_courts", input: {} }],
    }));
    const model = scriptedModel(looping);

    const error = await runAgent(
      { cnjNumber: CASE },
      { model, tools },
      { ...options, maxIterations: 3 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentDidNotConvergeError);
    expect((error as AgentDidNotConvergeError).message).toMatch(/within 3 model calls/);
    expect((error as AgentDidNotConvergeError).toolCalls).toEqual([
      "list_courts",
      "list_courts",
      "list_courts",
    ]);
    expect(model.requests).toHaveLength(3);
  });

  it("surfaces refusals and truncation as errors", async () => {
    const tools = await mcpTools();
    await expect(
      runAgent(
        { cnjNumber: CASE },
        { model: scriptedModel([{ stopReason: "refusal", category: "cyber" }]), tools },
        options,
      ),
    ).rejects.toThrow(/declined the request \(cyber\)/);
    await expect(
      runAgent(
        { cnjNumber: CASE },
        { model: scriptedModel([{ stopReason: "max_tokens" }]), tools },
        options,
      ),
    ).rejects.toThrow(AgentError);
  });

  it("rejects a final answer that does not match the schema", async () => {
    const tools = await mcpTools();
    const model = scriptedModel([{ final: { ...summary, statusCategory: "pending" } }]);
    await expect(runAgent({ cnjNumber: CASE }, { model, tools }, options)).rejects.toThrow(
      /did not match the CaseSummary schema/,
    );
  });
});

describe("monitorCase (pre-check)", () => {
  function tempStore() {
    const dir = mkdtempSync(join(tmpdir(), "datajud-state-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return new StateStore(dir);
  }

  it("runs the LLM on the first check and skips it when nothing changed", async () => {
    const store = tempStore();
    const tools = await mcpTools();
    const first = scriptedModel([{ final: summary }]);
    const run1 = await monitorCase({ cnjNumber: CASE }, { model: first, tools, store }, options);
    expect(run1.skipped).toBe(false);
    expect(first.requests).toHaveLength(1);

    const second = scriptedModel([]);
    const run2 = await monitorCase({ cnjNumber: CASE }, { model: second, tools, store }, options);
    expect(run2).toMatchObject({ skipped: true, previousSummary: summary });
    expect(second.requests).toHaveLength(0);
  });

  it("runs the LLM again when a new movement appears", async () => {
    const store = tempStore();
    const first = scriptedModel([{ final: summary }]);
    await monitorCase(
      { cnjNumber: CASE },
      { model: first, tools: await mcpTools(), store },
      options,
    );

    const updated = structuredClone(fixture);
    updated.hits.hits[0]!._source.movimentos!.push({
      codigo: 970,
      nome: "Audiência",
      dataHora: "2026-10-25T10:00:00.000Z",
    });
    const second = scriptedModel([{ final: summary }]);
    const run = await monitorCase(
      { cnjNumber: CASE },
      { model: second, tools: await mcpTools(updated), store },
      options,
    );
    expect(run.skipped).toBe(false);
    expect(second.requests).toHaveLength(1);
  });

  it("can be forced, and does not save state when the agent fails", async () => {
    const store = tempStore();
    const tools = await mcpTools();
    const failing = scriptedModel([{ stopReason: "refusal" }]);
    await expect(
      monitorCase({ cnjNumber: CASE }, { model: failing, tools, store }, options),
    ).rejects.toThrow(AgentError);

    // Nothing was saved, so the next run calls the model again.
    const retry = scriptedModel([{ final: summary }]);
    await monitorCase({ cnjNumber: CASE }, { model: retry, tools, store }, options);
    expect(retry.requests).toHaveLength(1);

    const forced = scriptedModel([{ final: summary }]);
    const run = await monitorCase(
      { cnjNumber: CASE },
      { model: forced, tools, store },
      { ...options, force: true },
    );
    expect(run.skipped).toBe(false);
  });
});
