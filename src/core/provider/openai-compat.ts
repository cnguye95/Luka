// The second transport: an OpenAI-compatible adapter with a configurable
// base URL.
//
// Chat Completions rather than Messages, and the base URL is a setting because
// the point of the shape is that many servers speak it — OpenAI itself, a
// gateway, or something running on localhost. Everything above `RawProvider`
// is unchanged: the wrapper still owns timeout, retries, per-task caps, JSON
// repair and the call counter (invariant 10).
//
// Invariant 9 holds the same way it does for Anthropic: the key is read from
// settings at call time and sent in one place, an Authorization header aimed
// at the configured base URL. It is never interpolated into anything else, and
// when it is empty no header is sent at all.
import type { HttpAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { normalizeSettings, type LukaSettings } from "../types";
import {
  bytesToBase64,
  clip,
  errorDetail,
  failureFrom,
  INCOMPLETE_REPLY_MESSAGE,
  NOT_JSON_MESSAGE,
} from "./http-shared";
import { ProviderError, type RawProvider, type RawRequest } from "./types";

/**
 * Which field carries the per-task cap.
 *
 * Current OpenAI models reject `max_tokens` and name `max_completion_tokens`
 * in the 400; most other servers speaking this shape know only the older name.
 * Neither is safe to send blind, and sending both is rejected by some servers,
 * so the transport picks one and learns from a refusal.
 */
type TokenField = "max_tokens" | "max_completion_tokens";

export function createOpenAICompatProvider(
  http: HttpAdapter,
  settings: LukaSettings,
): RawProvider {
  /**
   * Remembered for the life of this transport, which is one operation:
   * `createProvider` is called per compile and per ask. So a vault talking to
   * a server that wants the newer name pays the refusal once per run, not once
   * per source.
   */
  let tokenField: TokenField | null = null;

  return {
    async complete(request: RawRequest): Promise<string> {
      // Read live, and normalized here rather than trusted from the caller:
      // the plugin hands the wrapper its own mutable settings object, so an
      // untrimmed base URL typed a moment ago would otherwise reach `new URL`.
      const live = normalizeSettings(settings);
      const url = endpointOf(live.openaiBaseUrl);
      tokenField ??= defaultTokenField(url);

      const response = await http.request({
        url,
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A local server usually wants no credential, and an empty Bearer is
          // worse than none: some servers reject it outright.
          ...(live.openaiApiKey === "" ? {} : { authorization: `Bearer ${live.openaiApiKey}` }),
        },
        body: JSON.stringify(buildBody(request, tokenField)),
        timeoutMs: request.timeoutMs,
      });

      if (response.status < 200 || response.status >= 300) {
        const wrongField = tokenFieldRefusal(response, tokenField);
        if (wrongField !== null) {
          tokenField = wrongField.field;
          throw wrongField.error;
        }
        throw failureFrom(response);
      }

      return extractText(response.bytes);
    },
  };
}

/**
 * The Chat Completions endpoint under a configured root.
 *
 * Refused rather than repaired when it does not parse: settings normalization
 * deliberately leaves a malformed value as the user typed it, because
 * substituting OpenAI's address for a mistyped local one would send their key
 * somewhere they never named. This is where that decision is paid — before any
 * request, so nothing leaves the machine.
 */
function endpointOf(base: string): string {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new ProviderError(
      `OpenAI-compatible base URL is not a valid http(s) URL: ${clip(base)}`,
      { retryable: false },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError(
      `OpenAI-compatible base URL is not a valid http(s) URL: ${clip(base)}`,
      { retryable: false },
    );
  }
  // Everything the user typed is carried, not just the parts this transport
  // happens to think about. `URL.origin` drops userinfo and `search` is not in
  // the path, so building from those two alone silently deleted both — an
  // Azure deployment URL lost the `api-version` query it cannot work without,
  // and basic-auth credentials vanished, in each case leaving the server to
  // complain about something the user had in fact configured.
  const auth =
    parsed.username === ""
      ? ""
      : `${parsed.username}${parsed.password === "" ? "" : `:${parsed.password}`}@`;

  // The settings placeholder invites pasting a full endpoint, so a trailing
  // `/chat/completions` is dropped rather than doubled.
  const root = `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
  // The fragment is deliberately not carried: it is never sent to a server.
  return `${root}/chat/completions${parsed.search}`;
}

/**
 * Which token field to try first.
 *
 * OpenAI accepts `max_completion_tokens` on every chat model and rejects
 * `max_tokens` on the newer ones, so its own host starts there and never pays
 * the refusal. Anything else is likelier to be an older or smaller server that
 * knows only `max_tokens`.
 */
function defaultTokenField(url: string): TokenField {
  try {
    return new URL(url).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
  } catch {
    return "max_tokens";
  }
}

/**
 * A refusal that names the other token field, turned into one retry.
 *
 * Surfaced as a *retryable* error rather than handled inside the transport, so
 * the wrapper does the retrying: the attempt is counted like every other one
 * (the call counter counts transport attempts), and no request happens
 * that the layer above cannot see. `retryAfterMs: 1` because the ladder's
 * first rung is a second and there is nothing to wait for — the next request
 * differs from this one.
 *
 * It costs one unit of that call's retry budget, so with `maxRetries` at 0 the
 * first call of a run against such a server fails. The default of 2 covers
 * it; recorded as a known limitation rather than worked around.
 *
 * Learning runs one way only: `max_tokens` → `max_completion_tokens`, never
 * back. A multi-model gateway whose next model wants the older name therefore
 * fails for the rest of the run. It recovers across runs rather than within
 * one — the memo is per-transport and a transport is per operation, and
 * invariant 3 only manifests sources that succeeded, so each compile starts
 * from the host's default again and carries the sources it can. Accepted, and
 * recorded as a known limitation rather than fixed, because the
 * reverse direction needs a second signal this code cannot read: a 400 naming
 * `max_completion_tokens` is equally consistent with the field being wrong and
 * with its *value* being wrong.
 */
function tokenFieldRefusal(
  response: { status: number; bytes: Uint8Array },
  sent: TokenField,
): { field: TokenField; error: ProviderError } | null {
  if (sent !== "max_tokens" || response.status !== 400) return null;
  const detail = errorDetail(response.status, response.bytes);
  if (!/max_completion_tokens/i.test(detail.vendor ?? detail.message)) return null;
  return {
    field: "max_completion_tokens",
    error: new ProviderError(`${detail.message} — retrying with max_completion_tokens`, {
      status: response.status,
      retryable: true,
      retryAfterMs: 1,
      ...(detail.vendor === undefined ? {} : { vendorMessage: detail.vendor }),
    }),
  };
}

function buildBody(request: RawRequest, tokenField: TokenField): Record<string, unknown> {
  const images = request.images ?? [];
  // A plain string when there is nothing but text: it is what every server
  // speaking this shape accepts, while the parts array is newer.
  const content =
    images.length === 0
      ? request.user
      : [
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${bytesToBase64(image.data)}` },
          })),
          { type: "text", text: request.user },
        ];

  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content },
    ],
    [tokenField]: request.maxTokens,
  };
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  return body;
}

interface ChatChoice {
  finish_reason?: unknown;
  message?: { content?: unknown };
}

function extractText(bytes: Uint8Array): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new ProviderError(NOT_JSON_MESSAGE, { retryable: false });
  }

  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError("provider response has no choices", { retryable: false });
  }
  const choice = choices[0] as ChatChoice;

  // max_tokens is capped per task, and a reply that hit the cap is a fragment.
  // Same message as the Anthropic transport's, because it is the same fact and
  // it reaches the user through the same Notice.
  if (choice.finish_reason === "length") {
    throw new ProviderError(INCOMPLETE_REPLY_MESSAGE, { retryable: false });
  }

  const content = choice.message?.content;
  if (typeof content === "string") return content;
  // The parts form, as a server may answer when it was sent parts.
  if (Array.isArray(content)) {
    let text = "";
    for (const part of content as { type?: unknown; text?: unknown }[]) {
      if (part.type === "text" && typeof part.text === "string") text += part.text;
    }
    return text;
  }
  // `null` is what a server sends for a reply with no text — a tool call, say.
  // Empty is the honest reading, and the wrapper's JSON path fails on it with
  // a parse error naming what came back.
  return "";
}
