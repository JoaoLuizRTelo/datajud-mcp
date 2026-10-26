import { readFileSync } from "node:fs";

export type FakeReply =
  { status: number; body?: unknown; headers?: Record<string, string> } | { error: Error };

export interface FakeCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

/** A `fetch` stand-in that replays scripted replies in order and records every call. */
export function fakeFetch(replies: FakeReply[]) {
  const calls: FakeCall[] = [];
  const queue = [...replies];
  const fn: typeof globalThis.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init, body: init.body ? JSON.parse(init.body as string) : undefined });
    const reply = queue.shift();
    if (!reply) return Promise.reject(new Error(`Unexpected fetch #${calls.length} to ${url}`));
    if ("error" in reply) return Promise.reject(reply.error);
    return Promise.resolve(
      new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      }),
    );
  };
  return { fetch: fn, calls };
}

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

export const emptyResponse = {
  took: 5,
  timed_out: false,
  hits: { total: { value: 0, relation: "eq" }, max_score: null, hits: [] },
};

export const timeoutError = (): Error =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");
