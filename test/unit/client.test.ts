import { describe, expect, it } from "vitest";
import type { DataJudConfig } from "../../src/config.js";
import { DataJudClient } from "../../src/datajud/client.js";
import { DataJudError, parseRetryAfter } from "../../src/datajud/errors.js";
import {
  emptyResponse,
  fakeFetch,
  loadFixture,
  timeoutError,
  type FakeReply,
} from "../helpers/fake-fetch.js";

const config: DataJudConfig = {
  apiKey: "public-key",
  baseUrl: "https://datajud.test",
  timeoutMs: 1000,
  totalTimeoutMs: 60_000,
  maxAttempts: 4,
  requestsPerMinute: 120,
};

function clientWith(replies: FakeReply[]) {
  const fake = fakeFetch(replies);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = new DataJudClient(config, {
    fetch: fake.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    log: (m) => logs.push(m),
  });
  return { client, calls: fake.calls, sleeps, logs };
}

async function expectKind(promise: Promise<unknown>, kind: DataJudError["kind"]) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DataJudError);
  expect((error as DataJudError).kind).toBe(kind);
  return error as DataJudError;
}

describe("DataJudClient.search", () => {
  it("POSTs the query with the APIKey header to the court index", async () => {
    const { client, calls } = clientWith([{ status: 200, body: loadFixture("trf1-case.json") }]);
    const result = await client.search("TRF1", { query: { match_all: {} } });

    expect(result.hits.hits).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://datajud.test/api_publica_trf1/_search");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "APIKey public-key" });
    expect(calls[0]!.body).toEqual({ query: { match_all: {} } });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const { client, calls, sleeps, logs } = clientWith([
      { status: 429, body: { error: { type: "es_rejected_execution_exception" } } },
      { status: 503 },
      { status: 200, body: emptyResponse },
    ]);
    await expect(client.search("tjsp", {})).resolves.toMatchObject({ hits: { hits: [] } });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(logs[0]).toMatch(/attempt 1 failed/);
  });

  it("honors Retry-After on 429", async () => {
    const { client, sleeps } = clientWith([
      { status: 429, headers: { "retry-after": "7" } },
      { status: 200, body: emptyResponse },
    ]);
    await client.search("tjsp", {});
    expect(sleeps).toEqual([7000]);
  });

  it("retries timeouts and network failures", async () => {
    const { client, calls } = clientWith([
      { error: timeoutError() },
      { error: new TypeError("fetch failed") },
      { status: 200, body: emptyResponse },
    ]);
    await client.search("tjsp", {});
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxAttempts with a timeout error", async () => {
    const { client, calls } = clientWith(
      Array.from({ length: 4 }, () => ({ error: timeoutError() })),
    );
    const error = await expectKind(client.search("tjsp", {}), "timeout");
    expect(error.message).toMatch(/within 1 s/);
    expect(calls).toHaveLength(4);
  });

  it("does not retry when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = clientWith([
      { error: new DOMException("aborted", "AbortError") },
      { status: 200, body: emptyResponse },
    ]);
    await expectKind(client.search("tjsp", {}, { signal: controller.signal }), "cancelled");
    expect(calls).toHaveLength(1);
  });

  it("clips each attempt's timeout to the remaining total budget", async () => {
    let now = 0;
    const fake = fakeFetch([{ error: timeoutError() }, { status: 200, body: emptyResponse }]);
    const seen: number[] = [];
    const client = new DataJudClient(
      { ...config, timeoutMs: 90_000, totalTimeoutMs: 100_000 },
      {
        fetch: (input, init) => {
          seen.push(now);
          now += 95_000; // the first attempt burns most of the budget
          return fake.fetch(input, init);
        },
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
        random: () => 0.001,
      },
    );
    await client.search("tjsp", {});
    expect(seen).toHaveLength(2);
  });

  it("gives up once the total budget is spent", async () => {
    let now = 0;
    const fake = fakeFetch(Array.from({ length: 4 }, () => ({ error: timeoutError() })));
    const client = new DataJudClient(
      { ...config, timeoutMs: 90_000, totalTimeoutMs: 100_000 },
      {
        fetch: (input, init) => {
          now += 90_000;
          return fake.fetch(input, init);
        },
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
        random: () => 0.5,
      },
    );
    await expectKind(client.search("tjsp", {}), "timeout");
    expect(fake.calls).toHaveLength(2);
  });

  it("retries 200 responses with failed shards instead of returning partial results", async () => {
    const partial = {
      _shards: { total: 3, successful: 1, skipped: 0, failed: 2 },
      hits: { total: { value: 0, relation: "eq" }, hits: [] },
    };
    const { client, calls } = clientWith([
      { status: 200, body: partial },
      { status: 200, body: { _shards: { total: 3, successful: 3, failed: 0 }, ...emptyResponse } },
    ]);
    await client.search("tjsp", {});
    expect(calls).toHaveLength(2);

    const failing = clientWith(Array.from({ length: 4 }, () => ({ status: 200, body: partial })));
    const error = await expectKind(failing.client.search("tjsp", {}), "partial_results");
    expect(error.message).toMatch(/only 1 of 3 shards/);
  });

  it("treats ES overload as rate limiting even when reported as HTTP 400", async () => {
    const { client, calls } = clientWith([
      { status: 400, body: { error: { type: "es_rejected_execution_exception" } } },
      { status: 200, body: emptyResponse },
    ]);
    await client.search("tjsp", {});
    expect(calls).toHaveLength(2);
  });

  it("does not retry an invalid API key and explains how to fix it", async () => {
    const { client, calls } = clientWith([
      { status: 401, body: { error: { type: "security_exception" } } },
    ]);
    const error = await expectKind(client.search("tjsp", {}), "auth");
    expect(error.message).toMatch(/datajud-wiki\.cnj\.jus\.br\/api-publica\/acesso/);
    expect(calls).toHaveLength(1);
  });

  it("maps unknown indices to not_found", async () => {
    const { client } = clientWith([
      { status: 404, body: { error: { type: "index_not_found_exception" } } },
    ]);
    const error = await expectKind(client.search("xyz", {}), "not_found");
    expect(error.message).toMatch(/list_courts/);
  });

  it("surfaces Elasticsearch's reason for bad queries without retrying", async () => {
    const { client, calls } = clientWith([
      {
        status: 400,
        body: {
          error: {
            type: "search_phase_execution_exception",
            root_cause: [{ type: "illegal_argument_exception", reason: "Fielddata is disabled" }],
          },
        },
      },
    ]);
    const error = await expectKind(client.search("tjsp", {}), "bad_query");
    expect(error.message).toMatch(/Fielddata is disabled/);
    expect(calls).toHaveLength(1);
  });

  it("rejects responses that do not look like search results", async () => {
    const { client } = clientWith([{ status: 200, body: { unexpected: true } }]);
    await expectKind(client.search("tjsp", {}), "invalid_response");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
