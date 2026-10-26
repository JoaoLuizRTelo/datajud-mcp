import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeCursor, searchCasesQuery } from "../datajud/query.js";
import { caseRecordSchema, normalizeCase } from "../datajud/schemas.js";
import {
  courtInput,
  fail,
  ok,
  READ_ONLY_ANNOTATIONS,
  withProgress,
  type ToolDeps,
} from "./shared.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD");

export const searchCasesOutput = z.object({
  court: z.string(),
  total: z.object({
    value: z.number().int(),
    relation: z.string().describe("'eq' for an exact count, 'gte' when DataJud capped the count"),
  }),
  results: z.array(caseRecordSchema),
  nextCursor: z.string().nullable().describe("Pass as `cursor` to fetch the next page"),
});

export function registerSearchCases(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_cases",
    {
      title: "Search cases by filters",
      description:
        "Search one court's public cases by procedural class, subject, court unit and/or filing " +
        "date range. Class and subject use numeric codes from CNJ's Unified Procedural Tables " +
        "(TPU); `className` does a text match instead. Returns case covers without movements. " +
        "At least one filter is required. Paginate with `nextCursor`. Expect 20-60 s latency.",
      inputSchema: {
        court: courtInput,
        classCode: z.number().int().positive().optional().describe("TPU class code, e.g. 1116"),
        className: z
          .string()
          .min(3)
          .optional()
          .describe("Words in the class name, e.g. 'Execução Fiscal'"),
        subjectCodes: z
          .array(z.number().int().positive())
          .min(1)
          .max(20)
          .optional()
          .describe("TPU subject codes; matches cases with any of them"),
        courtUnitCode: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Court unit (órgão julgador) code"),
        filedFrom: isoDate.optional().describe("Filed on or after (YYYY-MM-DD)"),
        filedTo: isoDate.optional().describe("Filed on or before (YYYY-MM-DD)"),
        size: z.number().int().min(1).max(50).default(10),
        cursor: z.string().optional().describe("`nextCursor` from a previous call"),
      },
      outputSchema: searchCasesOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ court, ...filters }, extra) => {
      try {
        const query = searchCasesQuery(filters);
        const response = await withProgress(deps, extra, () =>
          deps.datajud.search(court, query, { signal: extra.signal }),
        );
        const hits = response.hits.hits;
        const lastSort = hits.at(-1)?.sort;
        return ok({
          court,
          total: response.hits.total ?? { value: hits.length, relation: "eq" },
          results: hits.map((hit) => normalizeCase(hit._source)),
          nextCursor: hits.length === filters.size && lastSort ? encodeCursor(lastSort) : null,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
