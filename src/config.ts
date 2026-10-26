import { z } from "zod";

const envSchema = z.object({
  DATAJUD_API_KEY: z
    .string({ error: "DATAJUD_API_KEY is not set." })
    .trim()
    .min(1, "DATAJUD_API_KEY is empty."),
  DATAJUD_BASE_URL: z.url().default("https://api-publica.datajud.cnj.jus.br"),
  DATAJUD_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  DATAJUD_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  DATAJUD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  DATAJUD_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(120),
});

export interface DataJudConfig {
  apiKey: string;
  baseUrl: string;
  /** Per HTTP attempt. */
  timeoutMs: number;
  /** Across all attempts and backoff waits of one search. */
  totalTimeoutMs: number;
  maxAttempts: number;
  requestsPerMinute: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DataJudConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `- ${i.message}`).join("\n");
    throw new ConfigError(
      `Invalid configuration:\n${problems}\n` +
        "Copy .env.example to .env and set DATAJUD_API_KEY to the current public key from " +
        "https://datajud-wiki.cnj.jus.br/api-publica/acesso",
    );
  }
  const e = parsed.data;
  return {
    apiKey: e.DATAJUD_API_KEY,
    baseUrl: e.DATAJUD_BASE_URL.replace(/\/+$/, ""),
    timeoutMs: e.DATAJUD_TIMEOUT_MS,
    totalTimeoutMs: e.DATAJUD_TOTAL_TIMEOUT_MS,
    maxAttempts: e.DATAJUD_MAX_ATTEMPTS,
    requestsPerMinute: e.DATAJUD_REQUESTS_PER_MINUTE,
  };
}
