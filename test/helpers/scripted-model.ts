import type Anthropic from "@anthropic-ai/sdk";
import type { ParsedBetaMessage } from "@anthropic-ai/sdk/lib/beta-parser";
import type { ModelClient } from "../../examples/agent/agent.js";
import type { CaseSummary } from "../../examples/agent/output-schema.js";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type StopReason = Anthropic.Beta.Messages.BetaStopReason;

export type ScriptedTurn =
  | { toolUses: { name: string; input: Record<string, unknown> }[] }
  | { final: unknown }
  | { stopReason: StopReason; category?: string };

let nextId = 0;

function message(
  content: unknown[],
  stopReason: StopReason,
  parsed: unknown,
  category?: string,
): ParsedBetaMessage<CaseSummary> {
  return {
    id: `msg_${++nextId}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content,
    stop_reason: stopReason,
    stop_details: category ? { type: "refusal", category, explanation: null } : null,
    stop_sequence: null,
    parsed_output: parsed,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
  } as unknown as ParsedBetaMessage<CaseSummary>;
}

/** A fake Claude that replays turns in order and records every request it receives. */
export function scriptedModel(turns: ScriptedTurn[]): ModelClient & { requests: Params[] } {
  const queue = [...turns];
  const requests: Params[] = [];
  return {
    requests,
    parse: (params) => {
      // Snapshot: the agent keeps appending to the same messages array.
      requests.push(JSON.parse(JSON.stringify(params)) as Params);
      const turn = queue.shift();
      if (!turn) return Promise.reject(new Error("Scripted model ran out of turns"));
      if ("toolUses" in turn) {
        const blocks = turn.toolUses.map((u) => ({
          type: "tool_use",
          id: `toolu_${++nextId}`,
          name: u.name,
          input: u.input,
        }));
        return Promise.resolve(message(blocks, "tool_use", null));
      }
      if ("final" in turn) {
        return Promise.resolve(
          message([{ type: "text", text: JSON.stringify(turn.final) }], "end_turn", turn.final),
        );
      }
      return Promise.resolve(message([], turn.stopReason, null, turn.category));
    },
  };
}
