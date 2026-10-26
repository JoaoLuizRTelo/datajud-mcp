import { describe, expect, it } from "vitest";
import { grade, loadCases } from "../../evals/grade.js";
import type { CaseSummary } from "../../examples/agent/output-schema.js";
import { existsSync } from "node:fs";

const summary: CaseSummary = {
  cnjNumber: "0713383-43.2025.8.07.0006",
  court: "tjdft",
  found: true,
  currentStatus: "Convicted.",
  statusCategory: "decided",
  lastRelevantMovements: [
    { date: "2026-10-08", instance: "G1", name: "Procedência", whyRelevant: "Judgment" },
  ],
  needsLawyerAttention: true,
  attentionReasons: ["Appeal deadline"],
  confidence: "high",
};

describe("grade", () => {
  it("passes when every graded field matches", () => {
    const checks = grade(
      {
        found: true,
        statusCategory: "decided",
        needsLawyerAttention: true,
        mustIncludeMovements: ["procedência"],
      },
      summary,
    );
    expect(checks.map((c) => c.name)).toEqual([
      "schema",
      "found",
      "statusCategory",
      "needsLawyerAttention",
      "movement:procedência",
    ]);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it("reports mismatches with details", () => {
    const checks = grade(
      { found: true, statusCategory: "archived", mustIncludeMovements: ["Baixa Definitiva"] },
      summary,
    );
    expect(checks.find((c) => c.name === "statusCategory")).toMatchObject({
      pass: false,
      detail: "expected archived, got decided",
    });
    expect(checks.find((c) => c.name === "movement:Baixa Definitiva")?.pass).toBe(false);
  });

  it("does not grade attention when the expectation is omitted", () => {
    const checks = grade({ found: true, statusCategory: "decided" }, summary);
    expect(checks.some((c) => c.name === "needsLawyerAttention")).toBe(false);
  });

  it("fails schema-invalid output", () => {
    expect(grade({ found: true, statusCategory: "decided" }, { nope: 1 })).toEqual([
      expect.objectContaining({ name: "schema", pass: false }),
    ]);
  });
});

describe("eval suite", () => {
  const cases = loadCases(new URL("../../evals/cases/", import.meta.url));

  it("has about ten valid cases, each pointing at an existing fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(existsSync(new URL(`../../evals/fixtures/${c.fixture}`, import.meta.url))).toBe(true);
    }
  });

  it("covers every status category", () => {
    expect(new Set(cases.map((c) => c.expected.statusCategory))).toEqual(
      new Set(["active", "suspended", "decided", "archived", "unknown"]),
    );
  });
});
