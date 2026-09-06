// §11's OpenAI-compatible transport. Mirrors `anthropic.test.ts` case for
// case, because the two answer to the same `RawProvider` contract and the
// wrapper above them cannot tell which one it is holding.
//
// The base URL under test is a local one, so the token field these cases see
// is `max_tokens` — the flip to `max_completion_tokens` is then a behaviour
// with a trigger rather than the default nothing distinguishes it from.
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/core/hash";
import { createOpenAICompatProvider } from "../src/core/provider/openai-compat";
import { ProviderError } from "../src/core/provider/types";
import { DEFAULT_SETTINGS, type LukaSettings } from "../src/core/types";
import { jsonRoute, ScriptedHttp, type StubRoute } from "./helpers/http";

const LOCAL = "http://localhost:11434/v1";

function settingsFor(over: Partial<LukaSettings> = {}): LukaSettings {
  return {
    ...DEFAULT_SETTINGS,
    provider: "openai-compatible",
    openaiApiKey: "sk-oai-test",
    openaiBaseUrl: LOCAL,
    ...over,
  };
}

const OK = jsonRoute(200, {
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
});

function transport(script: StubRoute[], settings: LukaSettings = settingsFor()) {
  const http = new ScriptedHttp(script);
  const raw = createOpenAICompatProvider(http, settings);
  return { http, raw };
}

const REQUEST = {
  model: "local-test-model",
  system: "You are terse.",
  user: "Say hello.",
  maxTokens: 123,
  temperature: 0.5,
  timeoutMs: 5000,
};

/** The body of the nth request the script received. */
function bodyOf(http: ScriptedHttp, n = 0): Record<string, unknown> {
  return JSON.parse(http.requests[n]?.body ?? "{}") as Record<string, unknown>;
}

describe("openai-compatible transport — request shape", () => {
  it("sends the Chat Completions request the shape describes", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete(REQUEST);

    const sent = http.requests[0];
    expect(sent?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(sent?.method).toBe("POST");
    expect(sent?.timeoutMs).toBe(5000);
    expect(sent?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-oai-test",
    });
    expect(bodyOf(http)).toEqual({
      model: "local-test-model",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Say hello." },
      ],
      max_tokens: 123,
      temperature: 0.5,
    });
  });

  it("appends the endpoint to a root however the user wrote it", async () => {
    // The placeholder in settings is a root, and the docs everyone reads show
    // the full endpoint — so both get pasted.
    for (const base of [LOCAL, `${LOCAL}/`, `${LOCAL}///`, `${LOCAL}/chat/completions`]) {
      const { http, raw } = transport([OK], settingsFor({ openaiBaseUrl: base }));
      await raw.complete(REQUEST);
      expect(http.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    }
  });

  it("sends no authorization header when no key is set", async () => {
    // A local server usually wants no credential, and an empty Bearer is worse
    // than none: some servers reject it outright.
    const { http, raw } = transport([OK], settingsFor({ openaiApiKey: "" }));
    await raw.complete(REQUEST);

    expect(http.requests[0]?.headers).toEqual({ "content-type": "application/json" });
  });

  it("omits temperature entirely when the caller set none", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete({ ...REQUEST, temperature: undefined });

    expect("temperature" in bodyOf(http)).toBe(false);
  });

  it("sends images as data URIs ahead of the text (§6.1's vision pass)", async () => {
    const { http, raw } = transport([OK]);
    await raw.complete({
      ...REQUEST,
      images: [{ mediaType: "image/png", data: utf8("Luka") }],
    });

    const messages = bodyOf(http)["messages"] as { role: string; content: unknown }[];
    expect(messages[1]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,THVrYQ==" } },
      { type: "text", text: "Say hello." },
    ]);
  });

  it("sends the key in the header and nowhere else (invariant 9)", async () => {
    // The Anthropic key is set too: neither may leak through this transport.
    const { http, raw } = transport(
      [OK],
      settingsFor({ apiKey: "sk-ant-secret", openaiApiKey: "sk-oai-secret" }),
    );
    await raw.complete(REQUEST);

    const sent = http.requests[0];
    expect(sent?.url).not.toContain("sk-");
    expect(sent?.body ?? "").not.toContain("sk-");
    expect(sent?.headers?.["x-api-key"]).toBeUndefined();
  });

  it("reads the key at call time, not at construction (invariant 9)", async () => {
    const settings = settingsFor({ openaiApiKey: "" });
    const http = new ScriptedHttp([OK]);
    const raw = createOpenAICompatProvider(http, settings);

    // Typed into the settings tab after the provider was built.
    settings.openaiApiKey = "sk-typed-later";
    await raw.complete(REQUEST);

    expect(http.requests[0]?.headers?.["authorization"]).toBe("Bearer sk-typed-later");
  });
});

describe("openai-compatible transport — which field carries the token cap", () => {
  it("uses max_completion_tokens against OpenAI's own host", async () => {
    // OpenAI accepts it on every chat model and rejects `max_tokens` on the
    // newer ones, so its own host never pays the refusal below.
    const { http, raw } = transport([OK], settingsFor({ openaiBaseUrl: "https://api.openai.com/v1" }));
    await raw.complete(REQUEST);

    const body = bodyOf(http);
    expect(body["max_completion_tokens"]).toBe(123);
    expect("max_tokens" in body).toBe(false);
  });

  it("learns from a refusal that names the other field, once per transport", async () => {
    const { http, raw } = transport([
      jsonRoute(400, {
        error: {
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        },
      }),
      OK,
      OK,
    ]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    // Retryable, so the wrapper above retries it and counts the attempt —
    // rather than the transport making a second request nothing can see.
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).retryable).toBe(true);
    expect((failure as ProviderError).retryAfterMs).toBe(1);
    expect((failure as ProviderError).status).toBe(400);
    expect((failure as ProviderError).vendorMessage).toContain("max_completion_tokens");

    await raw.complete(REQUEST);
    await raw.complete(REQUEST);
    for (const n of [1, 2]) {
      expect(bodyOf(http, n)["max_completion_tokens"]).toBe(123);
      expect("max_tokens" in bodyOf(http, n)).toBe(false);
    }
  });

  it("does not flip on a 400 that names something else", async () => {
    const { http, raw } = transport([
      jsonRoute(400, { error: { message: "model not found" } }),
      OK,
    ]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).retryable).toBe(false);

    await raw.complete(REQUEST);
    expect(bodyOf(http, 1)["max_tokens"]).toBe(123);
  });
});

describe("openai-compatible transport — a base URL it cannot use", () => {
  it("refuses a malformed URL before anything reaches the network", async () => {
    for (const bad of ["not a url", "ftp://files.example.com/v1", "/v1"]) {
      const { http, raw } = transport([OK], settingsFor({ openaiBaseUrl: bad }));
      const failure = await raw.complete(REQUEST).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).message).toContain("base URL");
      expect((failure as ProviderError).retryable).toBe(false);
      // The point of refusing here: a mistyped address never receives the key.
      expect(http.requests).toHaveLength(0);
    }
  });
});

describe("openai-compatible transport — reading the reply", () => {
  it("returns the assistant's text", async () => {
    const { raw } = transport([OK]);
    expect(await raw.complete(REQUEST)).toBe("hello");
  });

  it("concatenates a content array and ignores parts that are not text", async () => {
    const { raw } = transport([
      jsonRoute(200, {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: [
                { type: "text", text: "one " },
                { type: "refusal", refusal: "no" },
                { type: "text", text: "two" },
              ],
            },
          },
        ],
      }),
    ]);

    expect(await raw.complete(REQUEST)).toBe("one two");
  });

  it("reads a null content as empty rather than throwing", async () => {
    const { raw } = transport([
      jsonRoute(200, { choices: [{ finish_reason: "stop", message: { content: null } }] }),
    ]);

    expect(await raw.complete(REQUEST)).toBe("");
  });

  it("refuses a reply the model ran out of room to finish", async () => {
    // Same message as the Anthropic transport's: same fact, same Notice.
    const { raw } = transport([
      jsonRoute(200, { choices: [{ finish_reason: "length", message: { content: "half a th" } }] }),
    ]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).message).toMatch(/max_tokens/);
    expect((failure as ProviderError).retryable).toBe(false);
  });

  it("refuses a 2xx with no choices at all", async () => {
    const { raw } = transport([jsonRoute(200, { choices: [] })]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).message).toMatch(/no choices/);
    expect((failure as ProviderError).retryable).toBe(false);
  });

  it("refuses a 2xx body that is not JSON", async () => {
    // A proxy error page, say. The endpoint answered; the answer is unusable.
    const { raw } = transport([{ status: 200, bytes: utf8("<html>proxy error</html>") }]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).retryable).toBe(false);
    expect((failure as ProviderError).message).toMatch(/not JSON/);
  });
});

describe("openai-compatible transport — failures", () => {
  it("surfaces the vendor's error message with the status", async () => {
    const { raw } = transport([jsonRoute(429, { error: { message: "slow down" } })]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).message).toBe("HTTP 429: slow down");
    expect((failure as ProviderError).status).toBe(429);
  });

  it("reads a bare-string error body, as local servers send", async () => {
    const { raw } = transport([jsonRoute(404, { error: "model 'x' not found" })]);

    const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failure as ProviderError).message).toBe("HTTP 404: model 'x' not found");
  });

  it("classifies 429 and 5xx as retryable, other 4xx as not", async () => {
    const statuses: [number, boolean][] = [
      [429, true],
      [500, true],
      [503, true],
      [401, false],
      [404, false],
    ];

    for (const [status, retryable] of statuses) {
      const { raw } = transport([jsonRoute(status, { error: { message: "no" } })]);
      const failure = await raw.complete(REQUEST).catch((e: unknown) => e);
      expect((failure as ProviderError).retryable).toBe(retryable);
    }
  });

  it("honours Retry-After in seconds and ignores the date form", async () => {
    const seconds = transport([
      jsonRoute(429, { error: { message: "slow" } }, { "retry-after": "3" }),
    ]);
    const failedSeconds = await seconds.raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failedSeconds as ProviderError).retryAfterMs).toBe(3000);

    const dated = transport([
      jsonRoute(429, { error: { message: "slow" } }, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    ]);
    const failedDate = await dated.raw.complete(REQUEST).catch((e: unknown) => e);
    expect((failedDate as ProviderError).retryAfterMs).toBeUndefined();
  });
});
