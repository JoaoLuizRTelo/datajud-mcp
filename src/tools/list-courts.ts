import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COURTS } from "../datajud/courts.js";
import { ok } from "./shared.js";

const segment = z.enum(["superior", "federal", "state", "labor", "electoral", "military"]);

export const listCourtsOutput = z.object({
  courts: z.array(z.object({ alias: z.string(), name: z.string(), segment })),
});

export function registerListCourts(server: McpServer): void {
  server.registerTool(
    "list_courts",
    {
      title: "List courts",
      description:
        "List the courts available in DataJud and their aliases (the `court` parameter of the other " +
        "tools). Optionally filter by justice segment. The Supreme Court (STF) is not available.",
      inputSchema: { segment: segment.optional() },
      outputSchema: listCourtsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ segment: wanted }) =>
      ok({ courts: COURTS.filter((c) => wanted === undefined || c.segment === wanted) }),
  );
}
