import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMovementsOutput } from "../../src/tools/list-movements.js";
import type { ToolClient } from "./agent.js";
import type { CaseSummary } from "./output-schema.js";

/** What must change for a case to be worth another LLM call. */
export interface Fingerprint {
  instances: { instance: string; totalMovements: number; latestMovementAt: string | null }[];
}

/** Persisted per case. Holds only public case metadata, no personal data. */
export interface StoredState {
  cnjNumber: string;
  court: string;
  checkedAt: string;
  fingerprint: Fingerprint;
  summary: CaseSummary;
}

export class StateStore {
  constructor(private readonly dir = ".datajud-state") {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  load(key: string): StoredState | undefined {
    try {
      return JSON.parse(readFileSync(this.path(key), "utf8")) as StoredState;
    } catch {
      return undefined;
    }
  }

  save(key: string, state: StoredState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(key), `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface PrecheckResult {
  key: string;
  court: string;
  cnjNumber: string;
  fingerprint: Fingerprint;
  previous: StoredState | undefined;
  changed: boolean;
}

/**
 * Cost gate that runs before any LLM call: asks the MCP server for movement counts (no model
 * involved) and compares them with the last run. Unchanged case → skip the LLM entirely.
 */
export async function precheck(
  tools: ToolClient,
  input: { cnjNumber: string; court?: string | undefined },
  store: StateStore,
): Promise<PrecheckResult> {
  const result = await tools.callTool("list_movements", {
    cnjNumber: input.cnjNumber,
    ...(input.court ? { court: input.court } : {}),
    limit: 1,
  });
  if (result.isError) {
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
    throw new Error(`Pre-check failed: ${text}`);
  }
  const output = listMovementsOutput.parse(result.structuredContent);
  const fingerprint: Fingerprint = {
    instances: output.instances
      .map(({ instance, totalMovements, latestMovementAt }) => ({
        instance,
        totalMovements,
        latestMovementAt,
      }))
      .sort((a, b) => a.instance.localeCompare(b.instance)),
  };
  const key = `${output.court}-${output.cnjNumber.replace(/\D/g, "")}`;
  const previous = store.load(key);
  return {
    key,
    court: output.court,
    cnjNumber: output.cnjNumber,
    fingerprint,
    previous,
    changed: previous === undefined || !sameFingerprint(previous.fingerprint, fingerprint),
  };
}
