import type { CnjNumber } from "./cnj-number.js";

export type Segment = "superior" | "federal" | "state" | "labor" | "electoral" | "military";

export interface Court {
  /** Short alias used in the index name, e.g. `trf1` → `api_publica_trf1`. */
  alias: string;
  name: string;
  segment: Segment;
}

/**
 * State codes used in the `TR` part of CNJ numbers for state (J=8) and electoral (J=6) courts.
 * Index = TR code - 1.
 */
// prettier-ignore
const UF_BY_TR = [
  "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg", "pa",
  "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "se", "sp", "to",
] as const;

// prettier-ignore
const STATE_NAMES: Record<(typeof UF_BY_TR)[number], string> = {
  ac: "Acre", al: "Alagoas", ap: "Amapá", am: "Amazonas", ba: "Bahia", ce: "Ceará",
  df: "Distrito Federal e Territórios", es: "Espírito Santo", go: "Goiás", ma: "Maranhão",
  mt: "Mato Grosso", ms: "Mato Grosso do Sul", mg: "Minas Gerais", pa: "Pará", pb: "Paraíba",
  pr: "Paraná", pe: "Pernambuco", pi: "Piauí", rj: "Rio de Janeiro", rn: "Rio Grande do Norte",
  rs: "Rio Grande do Sul", ro: "Rondônia", rr: "Roraima", sc: "Santa Catarina", se: "Sergipe",
  sp: "São Paulo", to: "Tocantins",
};

/** DataJud spells the Federal District as `dft` in both the state and the electoral index. */
const ufAlias = (uf: string): string => (uf === "df" ? "dft" : uf);

function buildCourts(): Court[] {
  const courts: Court[] = [
    { alias: "tst", name: "Tribunal Superior do Trabalho", segment: "superior" },
    { alias: "tse", name: "Tribunal Superior Eleitoral", segment: "superior" },
    { alias: "stj", name: "Superior Tribunal de Justiça", segment: "superior" },
    { alias: "stm", name: "Superior Tribunal Militar", segment: "superior" },
  ];
  for (let r = 1; r <= 6; r++) {
    courts.push({
      alias: `trf${r}`,
      name: `Tribunal Regional Federal da ${r}ª Região`,
      segment: "federal",
    });
  }
  for (const uf of UF_BY_TR) {
    courts.push({
      alias: `tj${ufAlias(uf)}`,
      name: `Tribunal de Justiça - ${STATE_NAMES[uf]}`,
      segment: "state",
    });
  }
  for (let r = 1; r <= 24; r++) {
    courts.push({
      alias: `trt${r}`,
      name: `Tribunal Regional do Trabalho da ${r}ª Região`,
      segment: "labor",
    });
  }
  for (const uf of UF_BY_TR) {
    courts.push({
      alias: `tre-${ufAlias(uf)}`,
      name: `Tribunal Regional Eleitoral - ${STATE_NAMES[uf]}`,
      segment: "electoral",
    });
  }
  courts.push(
    { alias: "tjmmg", name: "Tribunal de Justiça Militar - Minas Gerais", segment: "military" },
    {
      alias: "tjmrs",
      name: "Tribunal de Justiça Militar - Rio Grande do Sul",
      segment: "military",
    },
    { alias: "tjmsp", name: "Tribunal de Justiça Militar - São Paulo", segment: "military" },
  );
  return courts;
}

/** Every index listed on https://datajud-wiki.cnj.jus.br/api-publica/endpoints (91 courts). */
export const COURTS: readonly Court[] = buildCourts();

export const COURT_ALIASES = COURTS.map((c) => c.alias) as [string, ...string[]];

const BY_ALIAS = new Map(COURTS.map((c) => [c.alias, c]));

export function findCourt(alias: string): Court | undefined {
  return BY_ALIAS.get(alias.toLowerCase());
}

export function indexName(alias: string): string {
  return `api_publica_${alias.toLowerCase()}`;
}

export class UnsupportedCourtError extends Error {
  override readonly name = "UnsupportedCourtError";
}

/**
 * Derives the DataJud court alias from the `J.TR` segments of a CNJ number.
 * Throws for courts that DataJud does not publish (e.g. the Supreme Court, STF).
 */
export function resolveCourtFromCnj(cnj: CnjNumber): Court {
  const tr = Number(cnj.court);
  const uf = UF_BY_TR[tr - 1];
  let alias: string | undefined;

  switch (cnj.segment) {
    case 1:
      throw new UnsupportedCourtError(
        "This is a Supreme Court (STF) case number. STF data is not available in the DataJud public API.",
      );
    case 3:
      alias = "stj";
      break;
    case 4:
      alias = tr >= 1 && tr <= 6 ? `trf${tr}` : undefined;
      break;
    case 5:
      alias = tr === 0 ? "tst" : tr <= 24 ? `trt${tr}` : undefined;
      break;
    case 6:
      alias = tr === 0 ? "tse" : uf ? `tre-${ufAlias(uf)}` : undefined;
      break;
    case 7:
      // Federal military justice is published as a single index.
      alias = "stm";
      break;
    case 8:
      alias = uf ? `tj${ufAlias(uf)}` : undefined;
      break;
    case 9:
      alias = { 13: "tjmmg", 21: "tjmrs", 26: "tjmsp" }[tr];
      break;
  }

  const court = alias ? findCourt(alias) : undefined;
  if (!court) {
    throw new UnsupportedCourtError(
      `Could not map segment ${cnj.segment}, court ${cnj.court} of ${cnj.formatted} to a DataJud index. ` +
        "Pass the `court` parameter explicitly (see the list_courts tool).",
    );
  }
  return court;
}
