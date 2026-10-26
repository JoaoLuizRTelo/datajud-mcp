import { z } from "zod";

export const STATUS_CATEGORIES = ["active", "suspended", "decided", "archived", "unknown"] as const;

/** The agent's final answer. Enforced through structured outputs and re-validated with zod. */
export const CaseSummary = z.object({
  cnjNumber: z.string().describe("Formatted CNJ number"),
  court: z.string().describe("DataJud court alias that holds the records, e.g. 'tjsp'"),
  found: z.boolean().describe("False when DataJud has no record of the case"),
  currentStatus: z.string().describe("One or two plain-English sentences on where the case stands"),
  statusCategory: z.enum(STATUS_CATEGORIES),
  lastRelevantMovements: z
    .array(
      z.object({
        date: z.string().describe("YYYY-MM-DD"),
        instance: z.string().describe("G1, G2, JE, TR, SUP, ..."),
        name: z.string().describe("Movement name exactly as returned by DataJud"),
        whyRelevant: z.string(),
      }),
    )
    .describe("Up to 5 most relevant recent movements, newest first; routine ones omitted"),
  needsLawyerAttention: z.boolean(),
  attentionReasons: z.array(z.string()).describe("Empty when needsLawyerAttention is false"),
  confidence: z.enum(["low", "medium", "high"]),
});

export type CaseSummary = z.infer<typeof CaseSummary>;
