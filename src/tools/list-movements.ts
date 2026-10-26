import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InvalidFilterError } from "../datajud/query.js";
import { movementSchema, normalizeMovement, sortMovements } from "../datajud/schemas.js";
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

export const listMovementsOutput = z.object({
  court: z.string(),
  cnjNumber: z.string(),
  found: z.boolean(),
  instances: z.array(
    z.object({
      instance: z.string().describe("G1 (first instance), G2 (appeal), JE, TR, SUP, ..."),
      totalMovements: z.number().int().describe("Movements in this instance, before filtering"),
      latestMovementAt: z.string().nullable(),
      movements: z.array(movementSchema),
    }),
  ),
});

export type ListMovementsOutput = z.infer<typeof listMovementsOutput>;

export function registerListMovements(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_movements",
    {
      title: "List case movements",
      description:
        "List the procedural movements (docket entries) of a case, newest first by default, grouped " +
        "by instance. Each movement carries its TPU code, the Portuguese name, structured " +
        "complements and, for common codes, a plain-English hint. Use `since` to get only new " +
        "movements. Expect 20-60 s latency.",
      inputSchema: {
        cnjNumber: cnjNumberInput,
        court: courtInput.optional(),
        limit: z.number().int().min(1).max(100).default(20).describe("Max movements per instance"),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/, "Use an ISO date such as 2025-01-31")
          .optional()
          .describe("Only movements on or after this ISO date/time"),
        order: z.enum(["desc", "asc"]).default("desc"),
      },
      outputSchema: listMovementsOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, extra) => {
      try {
        const sinceTime = args.since ? Date.parse(args.since) : undefined;
        if (Number.isNaN(sinceTime)) {
          throw new InvalidFilterError(`Invalid date "${args.since ?? ""}" for \`since\`.`);
        }
        const since = sinceTime === undefined ? undefined : new Date(sinceTime).toISOString();
        const { cnj, court, documents } = await withProgress(deps, extra, () =>
          lookupCase(deps, args, { onlyMovements: true, signal: extra.signal }),
        );
        const instances = documents.map((doc) => {
          const all = sortMovements((doc.movimentos ?? []).map(normalizeMovement));
          const filtered = since ? all.filter((m) => m.at !== null && m.at >= since) : all;
          const ordered = args.order === "asc" ? [...filtered].reverse() : filtered;
          return {
            instance: doc.grau ?? "",
            totalMovements: all.length,
            latestMovementAt: all[0]?.at ?? null,
            movements: ordered.slice(0, args.limit),
          };
        });
        const output: ListMovementsOutput = {
          court,
          cnjNumber: cnj.formatted,
          found: instances.length > 0,
          instances,
        };
        return ok(output);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
