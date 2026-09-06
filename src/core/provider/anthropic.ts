// Anthropic Messages API transport (handoff.md §11).
//
// Invariant 9: the API key is read from settings at call time and sent in one
// place — the x-api-key header of a request to the Anthropic endpoint. It is
// never interpolated into anything else.
import type { HttpAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import type { LukaSettings } from "../types";
import {
  bytesToBase64,
  failureFrom,
  INCOMPLETE_REPLY_MESSAGE,
  NOT_JSON_MESSAGE,
} from "./http-shared";
import { ProviderError, type RawProvider, type RawRequest } from "./types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export function createAnthropicProvider(http: HttpAdapter, settings: LukaSettings): RawProvider {
  return {
    async complete(request: RawRequest): Promise<string> {
      const response = await http.request({
        url: ANTHROPIC_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildBody(request)),
        timeoutMs: request.timeoutMs,
      });

      if (response.status < 200 || response.status >= 300) throw failureFrom(response);

      return extractText(response.bytes);
    },
  };
}

function buildBody(request: RawRequest): Record<string, unknown> {
  const content: unknown[] = [];
  for (const image of request.images ?? []) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: bytesToBase64(image.data),
      },
    });
  }
  content.push({ type: "text", text: request.user });

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user", content }],
  };
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  return body;
}

function extractText(bytes: Uint8Array): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new ProviderError(NOT_JSON_MESSAGE, {
      retryable: false,
    });
  }
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new ProviderError("provider response has no content array", { retryable: false });
  }
  // §11 caps max_tokens per task, and a reply that hit the cap is a fragment.
  // Unchecked, a JSON task burns the repair retry and then fails saying the
  // reply was not valid JSON, which is true but not the reason; a prose task
  // is worse, because the fragment is written into wiki/ under a code-written
  // citation block claiming the full citer set. Not retryable: the same call
  // returns the same length.
  if ((parsed as { stop_reason?: unknown }).stop_reason === "max_tokens") {
    throw new ProviderError(INCOMPLETE_REPLY_MESSAGE, {
      retryable: false,
    });
  }
  let text = "";
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * `bytesToBase64` moved to `http-shared.ts` with the OpenAI-compatible
 * transport, which needs it for the same reason. Re-exported here because the
 * transport's own tests import it by this path.
 */
export { bytesToBase64 } from "./http-shared";
