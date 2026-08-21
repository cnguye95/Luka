// Anthropic Messages API transport (handoff.md §11).
//
// Invariant 9: the API key is read from settings at call time and sent in one
// place — the x-api-key header of a request to the Anthropic endpoint. It is
// never interpolated into anything else.
import type { HttpAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import type { LukaSettings } from "../types";
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

      if (response.status < 200 || response.status >= 300) {
        throw new ProviderError(errorMessage(response.status, response.bytes), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs: parseRetryAfter(response.headers["retry-after"]),
        });
      }

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
    throw new ProviderError("provider returned a 2xx response that is not JSON", {
      retryable: false,
    });
  }
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new ProviderError("provider response has no content array", { retryable: false });
  }
  let text = "";
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * How much of a vendor's error text is worth carrying. The string travels into
 * a `CompileFailure.reason` and from there into a `Notice`, one per failed
 * source, and nothing downstream shortens it — a megabyte error body became a
 * megabyte notice. Enough to diagnose, not enough to be a payload.
 */
const MAX_VENDOR_MESSAGE = 500;

function errorMessage(status: number, bytes: Uint8Array): string {
  try {
    const parsed = JSON.parse(decodeUtf8(bytes)) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string" && parsed.error.message !== "") {
      return `HTTP ${status}: ${clip(parsed.error.message)}`;
    }
  } catch {
    // Not a JSON error body; the status alone will have to do.
  }
  return `HTTP ${status}`;
}

/** One line, bounded, with the truncation visible rather than silent. */
function clip(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_VENDOR_MESSAGE ? flat : `${flat.slice(0, MAX_VENDOR_MESSAGE)}…`;
}

/** Seconds form only; anything else falls back to the wrapper's backoff. */
function parseRetryAfter(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1000;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Hand-rolled so core needs neither Buffer nor btoa. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out +=
      (B64[(triple >> 18) & 63] as string) +
      (B64[(triple >> 12) & 63] as string) +
      (b === undefined ? "=" : (B64[(triple >> 6) & 63] as string)) +
      (c === undefined ? "=" : (B64[triple & 63] as string));
  }
  return out;
}
