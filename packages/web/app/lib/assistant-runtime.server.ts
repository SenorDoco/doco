import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
  Message,
  MessageCreateParamsNonStreaming,
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

export async function createSenorDocoMessage(
  params: Omit<MessageCreateParamsNonStreaming, "model"> & {
    model?: MessageCreateParamsNonStreaming["model"] | string;
  },
): Promise<Message> {
  const client = getSenorDocoAnthropicClient();
  if (!client) throw new Error(missingSenorDocoAnthropicMessage() ?? "Anthropic is unavailable.");
  const { model, ...rest } = params;
  return client.messages.create({
    ...rest,
    model: (model ?? getSenorDocoModel()) as MessageCreateParamsNonStreaming["model"],
  });
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
    model: (model ?? getSenorDocoModel()) as MessageCreateParamsNonStreaming["model"],
  });
}
