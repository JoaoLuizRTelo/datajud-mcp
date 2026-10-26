import { z } from "zod";
import { formatCnjDigits } from "./cnj-number.js";

/* ------------------------------------------------------------------------------------------------
 * Raw DataJud response. Deliberately lenient: the live API drifts from the published glossary
 * (string vs number codes, compact vs ISO dates, renamed sub-fields), so we coerce and tolerate
 * missing fields here and expose a strict, normalized shape below.
 * --------------------------------------------------------------------------------------------- */

const code = z.coerce.number().int();
const codeAndName = z.looseObject({ codigo: code.optional(), nome: z.string().optional() });

const rawMovement = z.looseObject({
  codigo: code.optional(),
  nome: z.string().optional(),
  dataHora: z.string().optional(),
  complementosTabelados: z
    .array(z.looseObject({ nome: z.string().optional(), descricao: z.string().optional() }))
    .optional(),
  orgaoJulgador: z
    .looseObject({ nome: z.string().optional(), nomeOrgao: z.string().optional() })
    .optional(),
});

const rawCase = z.looseObject({
  numeroProcesso: z.string(),
  tribunal: z.string().optional(),
  grau: z.string().optional(),
  nivelSigilo: z.coerce.number().optional(),
  dataAjuizamento: z.string().optional(),
  dataHoraUltimaAtualizacao: z.string().optional(),
  classe: codeAndName.optional(),
  assuntos: z.array(codeAndName).optional(),
  orgaoJulgador: z
    .looseObject({
      codigo: code.optional(),
      nome: z.string().optional(),
      codigoMunicipioIBGE: code.optional(),
    })
    .optional(),
  sistema: codeAndName.optional(),
  formato: codeAndName.optional(),
  movimentos: z.array(rawMovement).optional(),
});

export const rawSearchResponse = z.looseObject({
  hits: z.looseObject({
    total: z.looseObject({ value: z.number(), relation: z.string() }).optional(),
    hits: z.array(
      z.looseObject({
        _id: z.string().optional(),
        _source: rawCase,
        sort: z.array(z.unknown()).optional(),
      }),
    ),
  }),
});

export type RawSearchResponse = z.infer<typeof rawSearchResponse>;
export type RawCase = z.infer<typeof rawCase>;
type RawMovement = z.infer<typeof rawMovement>;

/* ------------------------------------------------------------------------------------------------
 * Normalized output (what MCP tools return). English field names, ISO dates, no nulls hidden in
 * nested optionals.
 * --------------------------------------------------------------------------------------------- */

export const codeNameSchema = z.object({ code: z.number().int().nullable(), name: z.string() });

export const movementSchema = z.object({
  code: z.number().int().nullable().describe("TPU movement code"),
  name: z.string().describe("Movement description, in Portuguese"),
  at: z.string().nullable().describe("ISO 8601 timestamp of the movement"),
  complements: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .describe("Structured complements, e.g. hearing type or document type"),
  courtUnit: z.string().nullable(),
});

export const caseRecordSchema = z.object({
  cnjNumber: z.string().describe("Formatted CNJ number"),
  court: z.string().describe("Court acronym, e.g. TRF1"),
  instance: z.string().describe("Instance/degree: G1 (first), G2 (appeal), JE (small claims), ..."),
  class: codeNameSchema.describe("Procedural class (TPU)"),
  subjects: z.array(codeNameSchema).describe("Subjects (TPU)"),
  courtUnit: z.object({
    code: z.number().int().nullable(),
    name: z.string(),
    ibgeCityCode: z.number().int().nullable(),
  }),
  system: z.string().nullable(),
  format: z.string().nullable().describe("Electronic or physical records"),
  filedAt: z.string().nullable().describe("ISO 8601 filing date"),
  lastUpdatedAt: z.string().nullable().describe("When DataJud last received data for this case"),
  secrecyLevel: z.number().int(),
  movementCount: z
    .number()
    .int()
    .nullable()
    .describe("Number of movements, or null when movements were not fetched"),
});

export type Movement = z.infer<typeof movementSchema>;
export type CaseRecord = z.infer<typeof caseRecordSchema>;

const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/;

/** Accepts ISO strings and DataJud's compact `yyyyMMdd[HHmmss]` form; returns ISO or null. */
export function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const compact = COMPACT_DATE.exec(value);
  const candidate = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] ?? "00"}:${compact[5] ?? "00"}:${compact[6] ?? "00"}Z`
    : value;
  const time = Date.parse(candidate);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function normalizeMovement(raw: RawMovement): Movement {
  return {
    code: raw.codigo ?? null,
    name: raw.nome ?? "(unnamed movement)",
    at: normalizeDate(raw.dataHora),
    complements: (raw.complementosTabelados ?? []).map((c) => ({
      name: c.nome ?? "",
      description: c.descricao ?? "",
    })),
    courtUnit: raw.orgaoJulgador?.nome ?? raw.orgaoJulgador?.nomeOrgao ?? null,
  };
}

/** Newest first; movements without a timestamp sink to the end. */
export function sortMovements(movements: Movement[], order: "asc" | "desc" = "desc"): Movement[] {
  const sign = order === "desc" ? -1 : 1;
  return [...movements].sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at < b.at ? -sign : sign;
  });
}

export function normalizeCase(raw: RawCase): CaseRecord {
  return {
    cnjNumber: formatCnjDigits(raw.numeroProcesso),
    court: raw.tribunal ?? "",
    instance: raw.grau ?? "",
    class: { code: raw.classe?.codigo ?? null, name: raw.classe?.nome ?? "" },
    subjects: (raw.assuntos ?? []).map((s) => ({ code: s.codigo ?? null, name: s.nome ?? "" })),
    courtUnit: {
      code: raw.orgaoJulgador?.codigo ?? null,
      name: raw.orgaoJulgador?.nome ?? "",
      ibgeCityCode: raw.orgaoJulgador?.codigoMunicipioIBGE ?? null,
    },
    system: raw.sistema?.nome ?? null,
    format: raw.formato?.nome ?? null,
    filedAt: normalizeDate(raw.dataAjuizamento),
    lastUpdatedAt: normalizeDate(raw.dataHoraUltimaAtualizacao),
    secrecyLevel: raw.nivelSigilo ?? 0,
    movementCount: raw.movimentos ? raw.movimentos.length : null,
  };
}
