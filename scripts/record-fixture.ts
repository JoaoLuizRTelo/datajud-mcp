/**
 * Records a live DataJud response as a test/eval fixture. Manual use only; tests never hit the API.
 *
 *   npm run record-fixture -- 0000832-35.2018.4.01.3202 test/fixtures/trf1-case.json
 *   npm run record-fixture -- 0000832-35.2018.4.01.3202 out.json --court trf1
 *
 * Only public case metadata is stored (DataJud does not expose parties or lawyers).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { DataJudClient } from "../src/datajud/client.js";
import { parseCnjNumber } from "../src/datajud/cnj-number.js";
import { resolveCourtFromCnj } from "../src/datajud/courts.js";
import { caseByNumberQuery } from "../src/datajud/query.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { court: { type: "string" } },
});
const [number, out] = positionals;
if (!number || !out) {
  console.error("Usage: npm run record-fixture -- <cnj-number> <output.json> [--court <alias>]");
  process.exit(1);
}

const cnj = parseCnjNumber(number);
const court = values.court ?? resolveCourtFromCnj(cnj).alias;
const client = new DataJudClient(loadConfig(), {
  log: (m) => {
    console.error(m);
  },
});

console.error(`Querying ${court} for ${cnj.formatted} (this can take a minute)...`);
const started = Date.now();
const response = await client.search(court, caseByNumberQuery(cnj.digits));
console.error(`Got ${response.hits.hits.length} document(s) in ${Date.now() - started} ms`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(response, null, 2)}\n`);
console.error(`Wrote ${out}`);
