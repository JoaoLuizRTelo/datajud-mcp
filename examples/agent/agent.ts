import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ParsedBetaMessage } from "@anthropic-ai/sdk/lib/beta-parser";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CaseSummary } from "./output-schema.js";
import { SYSTEM_PROMPT, userMessage } from "./prompts.js";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ParseParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The slice of the Anthropic SDK the agent uses; tests substitute a scripted model. */
export interface ModelClient {
  parse(params: ParseParams): Promise<ParsedBetaMessage<CaseSummary>>;
}

export function anthropicModelClient(client: Anthropic): ModelClient {
  return {
    parse: (params) => client.beta.messages.parse(params),
  };
}

/** The slice of an MCP client the agent uses. */
export interface ToolClient {
  listTools(): Promise<{
    tools: { name: string; description?: string | undefined; inputSchema: object }[];
  }>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/**
 * Adapts an MCP SDK client. DataJud calls can exceed the SDK's 60 s default request timeout, so
 * we ask for progress notifications and reset the timeout on each heartbeat from the server.
 */
export function mcpToolClient(
  client: McpClient,
  onProgress?: (message: string) => void,
): ToolClient {
  return {
    listTools: () => client.listTools(),
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args }, undefined, {
        timeout: 60_000,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 300_000,
        onprogress: (p) => onProgress?.(`${name}: ${p.message ?? "working"}`),
      })) as CallToolResult,
  };
}

export interface AgentOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Maximum model calls before giving up with AgentDidNotConvergeError. */
  maxIterations: number;
  maxTokens: number;
  /** "Today" for the model; fixed in evals so results are reproducible. */
  asOf: Date;
  /** Opt into server-side fallback on refusals (Claude API only). */
  refusalFallback: boolean;
  log?: (message: string) => void;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  model: "claude-opus-5-5",
  effort: "medium",
  maxIterations: 6,
  maxTokens: 16_000,
  asOf: new Date(),
  refusalFallback: true,
};

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AgentResult {
  summary: CaseSummary;
  iterations: number;
  toolCalls: string[];
  usage: AgentUsage;
}

export class AgentError extends Error {
  override readonly name: string = "AgentError";
  constructor(
    message: string,
    readonly iterations: number,
    readonly toolCalls: string[],
  ) {
    super(message);
  }
}

export class AgentDidNotConvergeError extends AgentError {
  override readonly name = "AgentDidNotConvergeError";
}

export async function runAgent(
  input: { cnjNumber: string; court?: string | undefined },
  deps: { model: ModelClient; tools: ToolClient },
  options: AgentOptions,
): Promise<AgentResult> {
  const { tools: mcpTools } = await deps.tools.listTools();
  const tools: BetaTool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as BetaTool["input_schema"],
  }));
  const known = new Set(tools.map((t) => t.name));

  // Append-only history: assistant turns are pushed back verbatim (thinking blocks included).
  const messages: BetaMessageParam[] = [
    { role: "user", content: userMessage({ ...input, asOf: options.asOf }) },
  ];
  const toolCalls: string[] = [];
  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    const response = await deps.model.parse({
      model: options.model,
      max_tokens: options.maxTokens,
      system: SYSTEM_PROMPT,
      tools,
      messages,
      // Caches tools + system + history between iterations of the loop.
      cache_control: { type: "ephemeral" },
      output_config: { effort: options.effort, format: betaZodOutputFormat(CaseSummary) },
      ...(options.refusalFallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;
    options.log?.(`[agent] iteration ${iteration}: stop_reason=${String(response.stop_reason)}`);

    switch (response.stop_reason) {
      case "refusal":
        throw new AgentError(
          `The model declined the request (${response.stop_details?.category ?? "no category"}).`,
          iteration,
          toolCalls,
        );
      case "max_tokens":
      case "model_context_window_exceeded":
        throw new AgentError(
          `The response was cut off (${response.stop_reason}).`,
          iteration,
          toolCalls,
        );
      case "pause_turn":
        messages.push({ role: "assistant", content: response.content });
        continue;
      case "tool_use": {
        messages.push({ role: "assistant", content: response.content });
        const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
        // Run parallel tool calls concurrently and answer all of them in one user turn.
        const results = await Promise.all(
          uses.map(async (use): Promise<BetaToolResultBlockParam> => {
            toolCalls.push(use.name);
            options.log?.(`[agent] → ${use.name} ${JSON.stringify(use.input)}`);
            if (!known.has(use.name)) {
              return {
                type: "tool_result",
                tool_use_id: use.id,
                is_error: true,
                content: `Unknown tool ${use.name}.`,
              };
            }
            try {
              const result = await deps.tools.callTool(
                use.name,
                use.input as Record<string, unknown>,
              );
              return {
                type: "tool_result",
                tool_use_id: use.id,
                is_error: result.isError === true,
                content: toolResultText(result),
              };
            } catch (error) {
              return {
                type: "tool_result",
                tool_use_id: use.id,
                is_error: true,
                content: `Tool call failed: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }),
        );
        messages.push({ role: "user", content: results });
        continue;
      }
      default: {
        // end_turn / stop_sequence: the final answer, constrained to CaseSummary.
        const parsed = CaseSummary.safeParse(response.parsed_output);
        if (!parsed.success) {
          throw new AgentError(
            `The final answer did not match the CaseSummary schema: ${parsed.error.message}`,
            iteration,
            toolCalls,
          );
        }
        return { summary: parsed.data, iterations: iteration, toolCalls, usage };
      }
    }
  }

  throw new AgentDidNotConvergeError(
    `The agent did not produce a final answer within ${options.maxIterations} model calls ` +
      `(tool calls: ${toolCalls.join(", ") || "none"}). Raise AGENT_MAX_ITERATIONS or check the tools.`,
    options.maxIterations,
    toolCalls,
  );
}

function toolResultText(result: CallToolResult): string {
  if (result.structuredContent && result.isError !== true)
    return JSON.stringify(result.structuredContent);
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}
