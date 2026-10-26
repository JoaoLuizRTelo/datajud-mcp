import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  caseRecordSchema,
  movementSchema,
  normalizeCase,
  normalizeMovement,
  sortMovements,
} from "../datajud/schemas.js";
import {
  courtInput,
  cnjNumberInput,
  fail,
  lookupCase,
  ok,
  READ_ONLY_ANNOTATIONS,
  withProgress,
  type ToolDeps,
} from "./shared.js";

export const getCaseOutput = z.object({
  court: z.string().describe("Court alias that was queried"),
  cnjNumber: z.string(),
  found: z.boolean(),
  records: z
    .array(caseRecordSchema.extend({ latestMovement: movementSchema.nullable() }))
    .describe("One record per instance (e.g. first instance and appeal) held by this court"),
});

export function registerGetCase(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_case",
    {
      title: "Get case by CNJ number",
      description:
        "Fetch the public cover data of a Brazilian court case from CNJ's DataJud: class, subjects, " +
        "court unit, filing date, instance and its most recent movement. Returns one record per " +
        "instance. Party and lawyer names are not available in DataJud. Expect 20-60 s latency.",
      inputSchema: { cnjNumber: cnjNumberInput, court: courtInput.optional() },
      outputSchema: getCaseOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, extra) => {
      try {
        const { cnj, court, documents } = await withProgress(deps, extra, () =>
          lookupCase(deps, args, { signal: extra.signal }),
        );
        const records = documents.map((doc) => ({
          ...normalizeCase(doc),
          latestMovement: sortMovements((doc.movimentos ?? []).map(normalizeMovement))[0] ?? null,
        }));
        return ok({ court, cnjNumber: cnj.formatted, found: records.length > 0, records });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
