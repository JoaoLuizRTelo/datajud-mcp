import {
  runAgent,
  type AgentOptions,
  type AgentResult,
  type ModelClient,
  type ToolClient,
} from "./agent.js";
import type { CaseSummary } from "./output-schema.js";
import { precheck, type StateStore } from "./precheck.js";

export type MonitorResult =
  | { skipped: true; reason: string; previousSummary: CaseSummary }
  | ({ skipped: false } & AgentResult);

/**
 * Pre-check → (maybe) agent → persist. The LLM only runs when the case changed since the last
 * successful run, or when `force` is set. State is saved only after a successful summary, so a
 * failed run is retried next time.
 */
export async function monitorCase(
  input: { cnjNumber: string; court?: string | undefined },
  deps: { model: ModelClient; tools: ToolClient; store: StateStore },
  options: AgentOptions & { force?: boolean; now?: () => Date },
): Promise<MonitorResult> {
  const log = options.log ?? (() => undefined);
  log("[precheck] fetching movement counts (no LLM call)...");
  const check = await precheck(deps.tools, input, deps.store);

  if (!check.changed && !options.force && check.previous) {
    log("[precheck] no new movements: skipping the LLM call.");
    return {
      skipped: true,
      reason: `No new movements since ${check.previous.checkedAt}.`,
      previousSummary: check.previous.summary,
    };
  }

  log(check.previous ? "[precheck] new movements found." : "[precheck] first check of this case.");
  const result = await runAgent(
    { cnjNumber: check.cnjNumber, court: input.court ?? check.court },
    deps,
    options,
  );
  deps.store.save(check.key, {
    cnjNumber: check.cnjNumber,
    court: check.court,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    fingerprint: check.fingerprint,
    summary: result.summary,
  });
  return { skipped: false, ...result };
}
