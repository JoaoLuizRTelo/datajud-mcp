import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CaseSummary, STATUS_CATEGORIES } from "../examples/agent/output-schema.js";

export const EvalCase = z.object({
  description: z.string(),
  input: z.object({ cnjNumber: z.string(), court: z.string().optional() }),
  fixture: z.string(),
  expected: z.object({
    found: z.boolean(),
    statusCategory: z.enum(STATUS_CATEGORIES),
    /** Omitted when reasonable lawyers could disagree; then it is not graded. */
    needsLawyerAttention: z.boolean().optional(),
    /** Each name must appear (case-insensitive substring) in lastRelevantMovements. */
    mustIncludeMovements: z.array(z.string()).optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCase> & { id: string };

export function loadCases(dir: URL): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      id: file.replace(/\.json$/, ""),
      ...EvalCase.parse(JSON.parse(readFileSync(new URL(file, dir), "utf8"))),
    }));
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Deterministic checks on structured fields only; free text is never graded. */
export function grade(expected: EvalCase["expected"], output: unknown): Check[] {
  const parsed = CaseSummary.safeParse(output);
  if (!parsed.success) {
    return [{ name: "schema", pass: false, detail: parsed.error.issues[0]?.message ?? "invalid" }];
  }
  const summary = parsed.data;
  const checks: Check[] = [
    { name: "schema", pass: true, detail: "valid" },
    {
      name: "found",
      pass: summary.found === expected.found,
      detail: `expected ${expected.found}, got ${summary.found}`,
    },
    {
      name: "statusCategory",
      pass: summary.statusCategory === expected.statusCategory,
      detail: `expected ${expected.statusCategory}, got ${summary.statusCategory}`,
    },
  ];
  if (expected.needsLawyerAttention !== undefined) {
    checks.push({
      name: "needsLawyerAttention",
      pass: summary.needsLawyerAttention === expected.needsLawyerAttention,
      detail: `expected ${expected.needsLawyerAttention}, got ${summary.needsLawyerAttention}`,
    });
  }
  const names = summary.lastRelevantMovements.map((m) => m.name.toLowerCase());
  for (const wanted of expected.mustIncludeMovements ?? []) {
    checks.push({
      name: `movement:${wanted}`,
      pass: names.some((n) => n.includes(wanted.toLowerCase())),
      detail: `"${wanted}" in [${summary.lastRelevantMovements.map((m) => m.name).join(", ")}]`,
    });
  }
  return checks;
}
