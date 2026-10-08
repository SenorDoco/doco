import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import { ensureEnvLoaded } from "./dotenv.server";

// Shared Señor Doco model defaults. Surfaces can still choose transport,
// tools, and output budget, but they should not quietly drift onto a
// different model/client stack.
export const SENOR_DOCO_DEFAULT_MODEL = "claude-sonnet-4-6";
export const SENOR_DOCO_DEFAULT_MAX_TOKENS = 8192;

let cachedClient: Anthropic | null = null;
let cachedApiKey: string | null = null;

export function getSenorDocoModel(): string {
  ensureEnvLoaded();
  return (
    process.env.SENOR_DOCO_ANTHROPIC_MODEL?.trim() ||
    process.env.DOCO_ASSISTANT_MODEL?.trim() ||
    SENOR_DOCO_DEFAULT_MODEL
  );
}

export function getSenorDocoAnthropicApiKey(): string | null {
  ensureEnvLoaded();
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function getSenorDocoAnthropicClient(): Anthropic | null {
  const apiKey = getSenorDocoAnthropicApiKey();
  if (!apiKey) return null;
  if (cachedClient && cachedApiKey === apiKey) return cachedClient;
  cachedApiKey = apiKey;
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export function missingSenorDocoAnthropicMessage(surface = "Señor Doco"): string | null {
  return getSenorDocoAnthropicApiKey()
    ? null
    : `ANTHROPIC_API_KEY is not configured on the server. Add it to .env to enable ${surface}.`;
}

/**
 * Drop empty (or whitespace-only) text content blocks before a request
 * leaves for Anthropic. The model occasionally emits a zero-length text
 * block — typically a leading `""` right before a `tool_use` — and once
 * that block is fed back into `messages` (within the same agent-loop
 * round, or re-loaded from persisted thread history on a later turn) the
 * API rejects the whole request with 400 "text content blocks must be
 * non-empty". This is the single boundary every Señor Doco surface
 * (website stream + Slack) passes through, so filtering here heals both a
 * live turn and any thread that already persisted such a block — no
 * per-surface or per-call-site cleanup needed.
 *
 * A message whose only blocks were empty text would itself become an
 * empty-content message (also a 400), so such a message is dropped
 * entirely. That can only happen for a degenerate turn that carried no
 * tool_use / tool_result / real text, so nothing of substance is lost.
 */
export function stripEmptyTextBlocks(messages: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message);
      continue;
    }
    const content = message.content.filter(
      (block) => block.type !== "text" || block.text.trim().length > 0,
    );
    if (content.length === 0) continue;
    out.push({ ...message, content });
  }
  return out;
}

export async function createSenorDocoMessage(
  params: Omit<MessageCreateParamsNonStreaming, "model"> & {
    model?: MessageCreateParamsNonStreaming["model"] | string;
  },
  options: { signal?: AbortSignal } = {},
): Promise<Message> {
  const client = getSenorDocoAnthropicClient();
  if (!client) throw new Error(missingSenorDocoAnthropicMessage() ?? "Anthropic is unavailable.");
  const { model, ...rest } = params;
  return client.messages.create(
    {
      ...rest,
      messages: stripEmptyTextBlocks(rest.messages),
      model: (model ?? getSenorDocoModel()) as MessageCreateParamsNonStreaming["model"],
    },
    options,
  );
}

export function streamSenorDocoMessage(
  params: Omit<MessageCreateParamsNonStreaming, "model" | "stream"> & {
    model?: MessageCreateParamsNonStreaming["model"] | string;
  },
): MessageStream {
  const client = getSenorDocoAnthropicClient();
  if (!client) throw new Error(missingSenorDocoAnthropicMessage() ?? "Anthropic is unavailable.");
  const { model, ...rest } = params;
  return client.messages.stream({
    ...rest,
    messages: stripEmptyTextBlocks(rest.messages),
    model: (model ?? getSenorDocoModel()) as MessageCreateParamsNonStreaming["model"],
  });
}
