import { describe, expect, it } from "vitest";
import { loadCases } from "../../evals/grade.js";
import { toolsFor } from "../../evals/harness.js";

/** Guards the eval suite itself: every case must reach its fixture through the real server. */
describe("eval fixtures", () => {
  const cases = loadCases(new URL("../../evals/cases/", import.meta.url));

  it.each(cases.map((c) => [c.id, c] as const))("%s resolves through get_case", async (_id, c) => {
    const { tools, close } = await toolsFor(c);
    try {
      const result = await tools.callTool("get_case", c.input);
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { found: boolean }).found).toBe(c.expected.found);
    } finally {
      await close();
    }
  });
});
