// What §11's two transports have in common: how a vendor's failure becomes a
// `ProviderError`, and how bytes become base64 for a vision call.
//
// Extracted from `anthropic.ts` when the OpenAI-compatible transport arrived.
// None of it is vendor-specific — both APIs answer a failure with
// `{"error": {"message": …}}`, both send `Retry-After` in seconds, and the
// wrapper above them decides on the same three fields whichever answered.
//
// The `message`/`vendorMessage` split in particular is shared because the
// *reason* for it is: `message` is clipped because it reaches a Notice, and
// `vendorMessage` is unclipped because §11's temperature re-run reads it. A
// transport that carried only the clipped copy would silently disable that
// re-run, which is exactly how it was broken once already.
import type { HttpResponse } from "../adapters";
import { decodeUtf8 } from "../hash";
import { ProviderError } from "./types";

/**
 * How much of a vendor's error text is worth carrying. The string travels into
 * a `CompileFailure.reason` and from there into a `Notice`, one per failed
 * source, and nothing downstream shortens it — a megabyte error body became a
 * megabyte notice. Enough to diagnose, not enough to be a payload.
 */
export const MAX_VENDOR_MESSAGE = 500;

/** §11's per-task cap was reached and the reply is a fragment, not an answer. */
export const INCOMPLETE_REPLY_MESSAGE = "provider reply hit max_tokens and is incomplete";

/** The endpoint answered, and the answer is unusable. Never worth retrying. */
export const NOT_JSON_MESSAGE = "provider returned a 2xx response that is not JSON";

/**
 * The clipped message a Notice may show, and the vendor's own text beside it.
 * They are separate because §11's temperature re-run decides on the vendor's
 * wording: a vendor that enumerates unsupported parameters at length would
 * otherwise push the word past the clip and fail every compile.
 */
export function errorDetail(status: number, bytes: Uint8Array): { message: string; vendor?: string } {
  try {
    const parsed = JSON.parse(decodeUtf8(bytes)) as { error?: { message?: unknown } | string };
    // `{"error": {"message": …}}` is what both vendors send. A bare string is
    // what some local servers send, and reading only the object shape turned
    // "model 'x' not found" into a bare "HTTP 404" with the reason discarded.
    const error = parsed.error;
    const vendor =
      typeof error === "string"
        ? error
        : typeof error?.message === "string"
          ? error.message
          : undefined;
    if (vendor !== undefined && vendor !== "") {
      return { message: `HTTP ${String(status)}: ${clip(vendor)}`, vendor };
    }
  } catch {
    // Not a JSON error body; the status alone will have to do.
  }
  return { message: `HTTP ${String(status)}` };
}

/** One line, bounded, with the truncation visible rather than silent. */
export function clip(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_VENDOR_MESSAGE ? flat : `${flat.slice(0, MAX_VENDOR_MESSAGE)}…`;
}

/**
 * A non-2xx response, as the wrapper needs to see it.
 *
 * §11 retries "429/5xx/network" and nothing else: every other 4xx is the
 * request's own fault and the same request will fail the same way.
 */
export function failureFrom(response: HttpResponse): ProviderError {
  const detail = errorDetail(response.status, response.bytes);
  return new ProviderError(detail.message, {
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
    retryAfterMs: parseRetryAfter(response.headers["retry-after"]),
    ...(detail.vendor === undefined ? {} : { vendorMessage: detail.vendor }),
  });
}

/**
 * Seconds form only; anything else falls back to the wrapper's backoff.
 *
 * Zero falls back too. It is not a shorter delay but no delay, and taken as a
 * value it beat the backoff ladder and took the jitter with it — the whole
 * retry budget spent in microseconds against a server that had just said it
 * was rate-limited. The ladder is the right answer when the vendor gives none.
 */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d+$/.test(header.trim())) return undefined;
  const ms = Number(header.trim()) * 1000;
  return ms > 0 ? ms : undefined;
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
