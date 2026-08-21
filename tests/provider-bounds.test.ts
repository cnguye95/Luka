import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider/wrapper";
import { ProviderError, type RawRequest } from "../src/core/provider/types";
import { DEFAULT_SETTINGS, type LukaSettings } from "../src/core/types";
import { createAnthropicProvider } from "../src/core/provider/anthropic";
import { localizeInlineImages } from "../src/core/normalize/image";
import { ScriptedHttp, StubHttp, jsonRoute } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { pngBytes } from "./helpers/images";
import { utf8 } from "../src/core/hash";

function harness(reply: () => Promise<string>, overrides: Partial<LukaSettings> = {}) {
  const seen: RawRequest[] = [];
  const provider = createProvider({
    http: new StubHttp({}),
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key", ...overrides },
    raw: {
      async complete(request: RawRequest): Promise<string> {
        seen.push(request);
        return reply();
      },
    },
    sleep: async () => {},
    random: () => 0.5,
  });
  return { provider, seen };
}

describe("a vendor cannot make the notice arbitrarily large", () => {
  it("bounds the message it lifts out of an error body", async () => {
    const huge = "x".repeat(1_000_000);
    const http = new StubHttp({
      "https://api.anthropic.com/v1/messages": {
        status: 500,
        headers: {},
        bytes: utf8(JSON.stringify({ error: { message: huge } })),
      },
    });
    const raw = createAnthropicProvider(http, { ...DEFAULT_SETTINGS, apiKey: "k" });

    const failure = await raw
      .complete({
        model: "m",
        system: "s",
        user: "u",
        maxTokens: 10,
        temperature: undefined,
        images: undefined,
        timeoutMs: 1000,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderError);
    // It still says what happened, without carrying a megabyte into a Notice.
    expect((failure as Error).message).toContain("HTTP 500");
    expect((failure as Error).message.length).toBeLessThan(2000);
  });
});

describe("a nonsense retry budget cannot silence the provider", () => {
  it("always makes at least one attempt", async () => {
    for (const maxRetries of [-1, -100, Number.NaN]) {
      const { provider, seen } = harness(async () => "ok", { maxRetries });
      await expect(
        provider.complete({ task: "synthesis", system: "s", user: "u" }),
      ).resolves.toBe("ok");
      expect([maxRetries, seen.length]).toEqual([maxRetries, 1]);
    }
  });

  it("does not retry more than the ceiling allows", async () => {
    const { provider, seen } = harness(async () => {
      throw new ProviderError("nope", { retryable: true, status: 500 });
    }, { maxRetries: 1000 });
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow(ProviderError);
    expect(seen.length).toBeLessThanOrEqual(11);
  });
});

describe("alt text may hold balanced brackets", () => {
  it("localizes an image whose alt text contains a bracketed aside", async () => {
    // Valid CommonMark: link text may contain balanced brackets. Excluding `]`
    // to keep alt text on one line also excluded this, which the line-at-a-time
    // reasoning does not cover.
    const url = "https://example.invalid/fig.png";
    const fs = new MemFs();
    const http = new StubHttp({ [url]: { status: 200, headers: {}, bytes: pngBytes(200, 200) } });

    const result = await localizeInlineImages(`Text.\n![a [b] c](${url})`, {
      fs,
      http,
      timeoutMs: 1000,
    });

    expect(result.localized).toBe(1);
    expect(result.text).toContain("raw/assets/");
    expect(result.text).not.toContain(url);
  });
});

describe("a bound written for a notice is not a behavioural input", () => {
  it("re-runs without temperature when the vendor names it past the clip", async () => {
    // §11 degrades a JSON task onto a model that refuses `temperature` by
    // re-running once without it. The predicate reads the vendor's message, so
    // clipping that message to bound a Notice must not decide the retry — a
    // vendor that enumerates unsupported parameters at length would otherwise
    // fail every compile.
    const padded = `${"unsupported parameter. ".repeat(40)}temperature is not supported`;
    expect(padded.length).toBeGreaterThan(500);

    const http = new ScriptedHttp([
      jsonRoute(400, { error: { message: padded } }),
      jsonRoute(200, { content: [{ type: "text", text: '{"ok":true}' }] }),
    ]);
    const provider = createProvider({
      http,
      settings: { ...DEFAULT_SETTINGS, apiKey: "k" },
      sleep: async () => {},
      random: () => 0.5,
    });

    await provider.complete({ task: "inventory", system: "s", user: "u", json: true });

    const temperatures = http.requests.map(
      (request) => (JSON.parse(request.body as string) as { temperature?: number }).temperature,
    );
    expect(temperatures).toEqual([0, undefined]);
  });
});

describe("localizing an image rewrites the link, not the prose", () => {
  it("leaves alt text alone when it repeats the URL", async () => {
    // `String.replace` with a *string* pattern takes the first occurrence in
    // the whole match, which is the alt text when the alt repeats the URL. The
    // user's prose is rewritten, the link stays remote, and because the
    // passthrough hash is taken after the write the file reads as unchanged
    // for ever — so the remote link is permanent and the asset is orphaned.
    const url = "https://example.invalid/fig.png";
    const fs = new MemFs();
    const http = new StubHttp({ [url]: { status: 200, headers: {}, bytes: pngBytes(200, 200) } });

    const result = await localizeInlineImages(`![${url}](${url})`, { fs, http, timeoutMs: 1000 });

    expect(result.localized).toBe(1);
    expect(result.text).toMatch(/^!\[https:\/\/example\.invalid\/fig\.png\]\(raw\/assets\//);
    expect(result.text).not.toMatch(/\]\(https:/);
  });

  it("leaves a title after the URL intact", async () => {
    const url = "https://example.invalid/fig.png";
    const fs = new MemFs();
    const http = new StubHttp({ [url]: { status: 200, headers: {}, bytes: pngBytes(200, 200) } });

    const result = await localizeInlineImages(`![alt](${url} "A title")`, {
      fs,
      http,
      timeoutMs: 1000,
    });

    expect(result.text).toContain('"A title"');
  });
});
