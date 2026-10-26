import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({ DATAJUD_API_KEY: "k" })).toEqual({
      apiKey: "k",
      baseUrl: "https://api-publica.datajud.cnj.jus.br",
      timeoutMs: 90_000,
      maxAttempts: 4,
      requestsPerMinute: 120,
    });
  });

  it("parses overrides and trims the base URL", () => {
    const config = loadConfig({
      DATAJUD_API_KEY: "k",
      DATAJUD_BASE_URL: "http://localhost:9200/",
      DATAJUD_TIMEOUT_MS: "5000",
      DATAJUD_REQUESTS_PER_MINUTE: "30",
    });
    expect(config).toMatchObject({
      baseUrl: "http://localhost:9200",
      timeoutMs: 5000,
      requestsPerMinute: 30,
    });
  });

  it("explains where to get the key when it is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/api-publica\/acesso/);
  });

  it("refuses to exceed the 120 requests/minute allowed by the Terms of Use", () => {
    expect(() => loadConfig({ DATAJUD_API_KEY: "k", DATAJUD_REQUESTS_PER_MINUTE: "500" })).toThrow(
      ConfigError,
    );
  });
});
