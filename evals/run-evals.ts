/**
 * Runs the agent against recorded DataJud fixtures with the real Claude API and grades the
 * structured output. DataJud is never called, so results are reproducible; the model is.
 *
 *   npm run evals                      # all cases
 *   npm run evals -- --only 05-suspended --concurrency 1
 *
 * Needs ANTHROPIC_API_KEY. Costs real money (roughly a few cents per case on Claude Opus 5.5).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicModelClient,
  DEFAULT_AGENT_OPTIONS,
  runAgent,
  type AgentUsage,
} from "../examples/agent/agent.js";
import { grade, loadCases, type Check, type EvalCase } from "./grade.js";
import { toolsFor } from "./harness.js";

if (existsSync(".env")) process.loadEnvFile(".env");

/** Fixed "today" matching when the fixtures were recorded, so recency rules are stable. */
const AS_OF = new Date("2026-10-26T12:00:00Z");

/** USD per million tokens. Cache writes assume the 5-minute TTL (1.25x input). Estimates only. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
};

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    model: { type: "string", default: process.env.ANTHROPIC_MODEL ?? DEFAULT_AGENT_OPTIONS.model },
    effort: { type: "string", default: process.env.ANTHROPIC_EFFORT ?? "medium" },
    concurrency: { type: "string", default: "3" },
  },
});

interface CaseResult {
  id: string;
  pass: boolean;
  checks: Check[];
  iterations?: number;
  toolCalls?: string[];
  usage?: AgentUsage;
  error?: string;
  output?: unknown;
}

async function runCase(
  evalCase: EvalCase,
  model: ReturnType<typeof anthropicModelClient>,
): Promise<CaseResult> {
  const { tools, close } = await toolsFor(evalCase);
  try {
    const result = await runAgent(
      evalCase.input,
      { model, tools },
      {
        ...DEFAULT_AGENT_OPTIONS,
        model: values.model,
        effort: values.effort as typeof DEFAULT_AGENT_OPTIONS.effort,
        asOf: AS_OF,
      },
    );
    const checks = grade(evalCase.expected, result.summary);
    return {
      id: evalCase.id,
      pass: checks.every((c) => c.pass),
      checks,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      usage: result.usage,
      output: result.summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: evalCase.id, pass: false, checks: [], error: message };
  } finally {
    await close();
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function estimateCost(usage: AgentUsage): number | undefined {
  const price = PRICES[values.model];
  if (!price) return undefined;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadInputTokens * price.cacheRead +
      usage.cacheCreationInputTokens * price.input * 1.25) /
    1_000_000
  );
}

const cases = loadCases(new URL("cases/", import.meta.url)).filter(
  (c) => values.only === undefined || c.id === values.only,
);
if (cases.length === 0) {
  console.error(`No eval case matches "${values.only ?? ""}".`);
  process.exit(1);
}

console.error(`Running ${cases.length} case(s) on ${values.model} (effort ${values.effort})...`);
const started = Date.now();
const model = anthropicModelClient(new Anthropic());
const results = await mapLimit(cases, Number(values.concurrency), async (c) => {
  const r = await runCase(c, model);
  console.error(`  ${r.pass ? "PASS" : "FAIL"}  ${c.id}`);
  return r;
});

const total: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
for (const r of results) {
  for (const key of Object.keys(total) as (keyof AgentUsage)[]) total[key] += r.usage?.[key] ?? 0;
}

console.log("\n| Case | Result | Status | Attention | Iterations | Notes |");
console.log("|---|---|---|---|---|---|");
for (const r of results) {
  const check = (name: string) => r.checks.find((c) => c.name === name);
  const cell = (name: string) => {
    const c = check(name);
    return c
      ? `${c.pass ? "✅" : "❌"} ${c.detail.replace(/^expected (\S+), got /, "$1 → ")}`
      : "–";
  };
  const failures = r.checks.filter(
    (c) => !c.pass && !["statusCategory", "needsLawyerAttention"].includes(c.name),
  );
  const notes = r.error ?? failures.map((c) => `${c.name}: ${c.detail}`).join("; ");
  console.log(
    `| ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${cell("statusCategory")} | ${cell("needsLawyerAttention")} | ${r.iterations ?? "–"} | ${notes} |`,
  );
}

const passed = results.filter((r) => r.pass).length;
const cost = estimateCost(total);
console.log(
  `\n**${passed}/${results.length} passed** in ${Math.round((Date.now() - started) / 1000)} s · ` +
    `${total.inputTokens} input + ${total.cacheReadInputTokens} cache-read + ` +
    `${total.cacheCreationInputTokens} cache-write + ${total.outputTokens} output tokens` +
    (cost === undefined ? "" : ` · ≈ $${cost.toFixed(3)}`),
);

mkdirSync("evals/results", { recursive: true });
writeFileSync(
  "evals/results/latest.json",
  `${JSON.stringify({ model: values.model, effort: values.effort, asOf: AS_OF, results, total }, null, 2)}\n`,
);
console.error("Details written to evals/results/latest.json");
process.exit(passed === results.length ? 0 : 1);
