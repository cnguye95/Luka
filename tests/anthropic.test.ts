import { describe, expect, it } from "vitest";
import { decodeUtf8, utf8 } from "../src/core/hash";
import { bytesToBase64, createAnthropicProvider } from "../src/core/provider/anthropic";
import { ProviderError } from "../src/core/provider/types";
import { DEFAULT_SETTINGS, type LukaSettings } from "../src/core/types";
import { jsonRoute, ScriptedHttp, type StubRoute } from "./helpers/http";

const SETTINGS: LukaSettings = { ...DEFAULT_SETTINGS, apiKey: "sk-test-key" };

const OK = jsonRoute(200, { content: [{ type: "text", text: "hello" }] });

function transport(script: StubRoute[]) {
  const http = new ScriptedHttp(script);
  const raw = createAnthropicProvider(http, SETTINGS);
  return { http, raw };
}

const REQUEST = {
  model: "claude-test-model",
  system: "You are terse.",
  user: "Say hello.",
  maxTokens: 123,
  temperature: 0.5,
  timeoutMs: 5000,
};

describe("anthropic transport — request shape", () => {
  it("sends the Messages API request the docs describe", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete(REQUEST);

    const sent = http.requests[0];
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.method).toBe("POST");
    expect(sent?.timeoutMs).toBe(5000);
    expect(sent?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-test-key",
      "anthropic-version": "2023-06-01",
    });

    const body = JSON.parse(sent?.body ?? "") as Record<string, unknown>;
    expect(body["model"]).toBe("claude-test-model");
    expect(body["max_tokens"]).toBe(123);
    expect(body["system"]).toBe("You are terse.");
    expect(body["temperature"]).toBe(0.5);
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "Say hello." }] },
    ]);
  });

  it("omits temperature entirely when undefined, deferring to the API default", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete({ ...REQUEST, temperature: undefined });
    const body = JSON.parse(http.requests[0]?.body ?? "") as Record<string, unknown>;
    expect("temperature" in body).toBe(false);
  });

  it("sends images as base64 content blocks ahead of the text (§11 vision)", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete({
      ...REQUEST,
      images: [{ mediaType: "image/png", data: utf8("Luka") }],
    });

    const body = JSON.parse(http.requests[0]?.body ?? "") as {
      messages: { content: unknown[] }[];
    };
    expect(body.messages[0]?.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "THVrYQ==" },
      },
      { type: "text", text: "Say hello." },
    ]);
  });

  it("sends the key nowhere except the x-api-key header (invariant 9)", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete(REQUEST);
    const sent = http.requests[0];
    expect(sent?.body).not.toContain("sk-test-key");
    expect(sent?.url).not.toContain("sk-test-key");
  });
});

describe("anthropic transport — responses", () => {
  it("concatenates text blocks and ignores other block types", async () => {
    const { raw } = transport([
      jsonRoute(200, {
        content: [
          { type: "text", text: "Hello " },
          { type: "tool_use", id: "x" },
          { type: "text", text: "world" },
        ],
      }),
    ]);
    await expect(raw.complete(REQUEST)).resolves.toBe("Hello world");
  });

  it("surfaces the vendor's error message with the status", async () => {
    const { raw } = transport([
      jsonRoute(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
    ]);
    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toBe("HTTP 429: slow down");
    expect((failure as ProviderError).status).toBe(429);
  });

  it("reads an error body that is a bare string, as local servers send", async () => {
    // Ollama and friends answer `{"error": "..."}` rather than nesting a
    // message. Reading only the nested shape turned the whole reason into a
    // bare "HTTP 404" — shared with the OpenAI-compatible transport, which is
    // the one that meets those servers.
    const { raw } = transport([jsonRoute(404, { error: "model 'x' not found" })]);
    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).message).toBe("HTTP 404: model 'x' not found");
    expect((failure as ProviderError).vendorMessage).toBe("model 'x' not found");
  });

  it("classifies 429 and 5xx as retryable, other 4xx as not", async () => {
    const statuses: [number, boolean][] = [
      [429, true],
      [500, true],
      [529, true],
      [400, false],
      [401, false],
      [404, false],
    ];
    for (const [status, retryable] of statuses) {
      const { raw } = transport([jsonRoute(status, {})]);
      const failure = (await raw.complete(REQUEST).catch((e: unknown) => e)) as ProviderError;
      expect(failure.retryable, `status ${status}`).toBe(retryable);
    }
  });

  it("parses a seconds-form Retry-After and ignores other forms", async () => {
    const { raw } = transport([jsonRoute(429, {}, { "retry-after": "3" })]);
    const failure = (await raw.complete(REQUEST).catch((e: unknown) => e)) as ProviderError;
    expect(failure.retryAfterMs).toBe(3000);

    const dated = transport([
      jsonRoute(429, {}, { "retry-after": "Wed, 20 Aug 2026 07:28:00 GMT" }),
    ]);
    const datedFailure = (await dated.raw
      .complete(REQUEST)
      .catch((e: unknown) => e)) as ProviderError;
    expect(datedFailure.retryAfterMs).toBeUndefined();
  });

  it("returns the empty string for a content array with no text blocks", async () => {
    const { raw } = transport([jsonRoute(200, { content: [] })]);
    await expect(raw.complete(REQUEST)).resolves.toBe("");
  });

  it("treats a 2xx body that is not JSON as a non-retryable failure", async () => {
    const { raw } = transport([{ status: 200, bytes: utf8("<html>proxy error</html>") }]);
    const failure = (await raw.complete(REQUEST).catch((e: unknown) => e)) as ProviderError;
    expect(failure.retryable).toBe(false);
  });
});

describe("bytesToBase64", () => {
  it("matches known vectors including both padding cases", () => {
    expect(bytesToBase64(utf8(""))).toBe("");
    expect(bytesToBase64(utf8("L"))).toBe("TA==");
    expect(bytesToBase64(utf8("Lu"))).toBe("THU=");
    expect(bytesToBase64(utf8("Luk"))).toBe("THVr");
    expect(bytesToBase64(utf8("Luka"))).toBe("THVrYQ==");
  });

  it("handles arbitrary binary, not just ASCII", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);
    // Independently computed: 00 ff 10 -> AP8Q, 80 7f -> gH8=
    expect(bytesToBase64(bytes)).toBe("AP8QgH8=");
    expect(decodeUtf8(utf8("check")).length).toBe(5);
  });
});
