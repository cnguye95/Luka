// Settings: the normative defaults, the normalization that keeps a
// hand-edited data.json from reaching the transport, invariant 9's
// read-at-call-time rule alongside the per-run snapshot it has to coexist
// with, and the model ids that follow a provider change.
import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider/wrapper";
import { utf8 } from "../src/core/hash";
import {
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_OPENAI_MODELS,
  DEFAULT_SETTINGS,
  PPR_EPSILON,
  PROVIDER_TASKS,
  modelsForProvider,
  normalizeSettings,
  type LukaSettings,
} from "../src/core/types";

// The defaults are normative.
describe("default settings", () => {
  it("matches the documented defaults", () => {
    expect(DEFAULT_SETTINGS.pprAlpha).toBe(0.85);
    expect(PPR_EPSILON).toBe(1e-8);
    expect(DEFAULT_SETTINGS.pprMaxIterations).toBe(100);
    expect(DEFAULT_SETTINGS.modeMinNodes).toBe(20);
    expect(DEFAULT_SETTINGS.modeMinLinkRatio).toBe(1.5);
    expect(DEFAULT_SETTINGS.contextBudgetTokens).toBe(40_000);
    expect(DEFAULT_SETTINGS.assemblyCap).toBe(12);
    expect(DEFAULT_SETTINGS.seedsCap).toBe(8);
    expect(DEFAULT_SETTINGS.keywordsCap).toBe(12);
    expect(DEFAULT_SETTINGS.followUpEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.maxRetries).toBe(2);
    expect(DEFAULT_SETTINGS.requestTimeoutMs).toBe(120_000);
    expect(DEFAULT_SETTINGS.compileConcurrency).toBe(2);
  });

  it("maps every provider task to a model id", () => {
    for (const task of PROVIDER_TASKS) {
      expect(DEFAULT_SETTINGS.models[task]).toMatch(/\S/);
    }
  });

  it("ships no API key of either kind (invariant 9)", () => {
    expect(DEFAULT_SETTINGS.apiKey).toBe("");
    expect(DEFAULT_SETTINGS.openaiApiKey).toBe("");
  });

  it("defaults to Anthropic, with Anthropic model ids to match", () => {
    // Anthropic is the default provider and the default ids are its own, so the
    // two have to agree: shipping an OpenAI-compatible default would point
    // every task at a model the configured endpoint does not have.
    expect(DEFAULT_SETTINGS.provider).toBe("anthropic");
    for (const task of PROVIDER_TASKS) {
      expect(DEFAULT_SETTINGS.models[task]).toMatch(/^claude-/);
    }
  });

  it("defaults the OpenAI-compatible base URL to OpenAI's own", () => {
    expect(DEFAULT_SETTINGS.openaiBaseUrl).toBe("https://api.openai.com/v1");
  });
});

describe("a hand-edited provider selection cannot reach the transport unrecognized", () => {
  const settings = (over: Partial<LukaSettings>): LukaSettings =>
    normalizeSettings({ ...DEFAULT_SETTINGS, ...over });

  it("falls back to Anthropic for a name that is not one of the two", () => {
    for (const bad of ["openai", "", "ANTHROPIC", 3, null, undefined]) {
      expect(settings({ provider: bad as unknown as LukaSettings["provider"] }).provider).toBe(
        "anthropic",
      );
    }
  });

  it("keeps a name that is one of the two", () => {
    expect(settings({ provider: "openai-compatible" }).provider).toBe("openai-compatible");
    expect(settings({ provider: "anthropic" }).provider).toBe("anthropic");
  });

  it("falls back to the default base URL when the field is empty or absent", () => {
    for (const blank of ["", "   ", undefined, 7]) {
      expect(settings({ openaiBaseUrl: blank as unknown as string }).openaiBaseUrl).toBe(
        DEFAULT_SETTINGS.openaiBaseUrl,
      );
    }
  });

  it("leaves a malformed base URL as typed rather than substituting OpenAI's", () => {
    // Substituting the default here would send the key of a user who mistyped
    // their own server's address to api.openai.com. The transport refuses this
    // value instead, before any request leaves.
    expect(settings({ openaiBaseUrl: "not a url" }).openaiBaseUrl).toBe("not a url");
  });

  it("trims the base URL and the key", () => {
    expect(settings({ openaiBaseUrl: "  http://localhost:11434/v1  " }).openaiBaseUrl).toBe(
      "http://localhost:11434/v1",
    );
    expect(settings({ openaiApiKey: "  sk-oai  " }).openaiApiKey).toBe("sk-oai");
    expect(settings({ openaiApiKey: 5 as unknown as string }).openaiApiKey).toBe("");
  });
});

describe("a hand-edited data.json cannot make compile unsafe", () => {
  // These values have defaults, but `data.json` is a file a user can edit and
  // `loadSettings` validates nothing. wrapper.ts wrote this threat model down
  // for `maxRetries` and it was never applied to the three settings beside it.
  const nonsense = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, "two" as unknown as number];

  it("falls back to the default for a budget that would silence every source", () => {
    for (const value of nonsense) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, contextBudgetTokens: value })
        .contextBudgetTokens).toBe(DEFAULT_SETTINGS.contextBudgetTokens);
    }
  });

  it("falls back for a timeout that would reject every request", () => {
    for (const value of nonsense) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, requestTimeoutMs: value }).requestTimeoutMs)
        .toBe(DEFAULT_SETTINGS.requestTimeoutMs);
    }
  });

  it("keeps concurrency inside a range mapWithConcurrency can act on", () => {
    for (const value of nonsense) {
      const settings = normalizeSettings({ ...DEFAULT_SETTINGS, compileConcurrency: value });
      expect(settings.compileConcurrency).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(settings.compileConcurrency)).toBe(true);
    }
    // A large value is capped rather than allowed to ignore the concurrency budget.
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, compileConcurrency: 5000 }).compileConcurrency,
    ).toBe(16);
  });

  it("clamps the retry budget in the same place as the rest", () => {
    // A number outside the range is clamped into it; a value that is not a
    // number at all falls back to the default, which is what the rule says
    // and what a quoted `"maxRetries": "3"` in data.json deserves.
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: -1 }).maxRetries).toBe(0);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: 5000 }).maxRetries).toBe(10);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: Number.NaN }).maxRetries).toBe(
      DEFAULT_SETTINGS.maxRetries,
    );
  });

  it("answers the default for a quoted number, not the range floor", () => {
    const quoted = "4" as unknown as number;

    expect(normalizeSettings({ ...DEFAULT_SETTINGS, compileConcurrency: quoted })
      .compileConcurrency).toBe(DEFAULT_SETTINGS.compileConcurrency);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: quoted }).maxRetries).toBe(
      DEFAULT_SETTINGS.maxRetries,
    );
  });

  it("leaves a settings object that is already valid alone", () => {
    // `toEqual`, not `toBe`, on purpose: this returns a snapshot by design, so
    // a compile sees one consistent settings state. What must *not* be
    // snapshotted is the object core holds between runs — that is invariant 9,
    // and the two tests below are what constrain it.
    expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(DEFAULT_SETTINGS)).not.toBe(DEFAULT_SETTINGS);
  });
});

describe("invariant 9: settings are read at call time", () => {
  // `src/plugin/settings.ts` mutates the settings object in place and
  // `createCore` is called once in `onload()`, so anything that snapshots the
  // object at construction makes a freshly typed API key invisible until
  // Obsidian reloads — with the settings tab and data.json both saying it took.
  it("sees an API key typed after the provider was built", async () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "" };
    const sent: string[] = [];
    const provider = createProvider({
      http: {
        async request(req) {
          sent.push(req.headers?.["x-api-key"] ?? "");
          return {
            status: 200,
            headers: {},
            bytes: utf8(JSON.stringify({ content: [{ type: "text", text: "ok" }] })),
          };
        },
      },
      settings,
      sleep: async () => {},
      random: () => 0.5,
    });

    settings.apiKey = "sk-ant-typed-later";
    await provider.complete({ task: "synthesis", system: "s", user: "u" });

    expect(sent).toEqual(["sk-ant-typed-later"]);
  });

  it("sees a model id changed after the core was built", async () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "k" };
    const seen: string[] = [];
    const provider = createProvider({
      http: {
        async request(req) {
          seen.push((JSON.parse(req.body as string) as { model: string }).model);
          return {
            status: 200,
            headers: {},
            bytes: utf8(JSON.stringify({ content: [{ type: "text", text: "ok" }] })),
          };
        },
      },
      settings,
      sleep: async () => {},
      random: () => 0.5,
    });

    settings.models = { ...settings.models, synthesis: "claude-changed-later" };
    await provider.complete({ task: "synthesis", system: "s", user: "u" });

    expect(seen).toEqual(["claude-changed-later"]);
  });
});

describe("a run sees one settings state", () => {
  it("does not let a model id change under a compile already in flight", async () => {
    // The settings tab writes `settings.models[task]` on every keystroke, so a
    // shallow snapshot lets a half-typed model id reach the vendor mid-run —
    // 404s, failed sources, and one compile's pages generated by two models.
    // Built the way `loadSettings` builds it — models copied, not shared.
    const live = { ...DEFAULT_SETTINGS, apiKey: "k", models: { ...DEFAULT_SETTINGS.models } };
    const snapshot = normalizeSettings(live);
    const before = snapshot.models.synthesis;

    live.models.synthesis = "claude-sonn";

    expect(snapshot.models.synthesis).toBe(before);
    expect(snapshot.models.synthesis).not.toBe("claude-sonn");
  });
});

describe("PageRank's numbers survive a hand-edited data.json", () => {
  it("falls back for a damping factor the iteration cannot use", () => {
    // Outside (0,1) the update stops being a contraction: at 1 it never
    // teleports, at 0 it never walks. Neither boundary is a usable clamp, so
    // an unusable value takes the default instead.
    for (const value of [0, 1, -0.5, 1.5, Number.NaN, "0.9" as unknown as number]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, pprAlpha: value }).pprAlpha).toBe(
        DEFAULT_SETTINGS.pprAlpha,
      );
    }
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, pprAlpha: 0.5 }).pprAlpha).toBe(0.5);
  });

  it("keeps the iteration count inside a range the loop can act on", () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, pprMaxIterations: 0 }).pprMaxIterations).toBe(1);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, pprMaxIterations: -5 }).pprMaxIterations).toBe(1);
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, pprMaxIterations: 5_000_000 }).pprMaxIterations,
    ).toBe(1000);
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, pprMaxIterations: Number.NaN }).pprMaxIterations,
    ).toBe(DEFAULT_SETTINGS.pprMaxIterations);
  });
});

describe("the follow-up toggle survives a hand-edited data.json", () => {
  it("takes the default for anything that is not a boolean", () => {
    // A string or a number is not a decision either way, so it falls back
    // rather than taking JavaScript's idea of whether it is truthy.
    for (const value of ["false" as unknown as boolean, 0 as unknown as boolean, null as unknown as boolean]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, followUpEnabled: value }).followUpEnabled).toBe(
        DEFAULT_SETTINGS.followUpEnabled,
      );
    }
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, followUpEnabled: false }).followUpEnabled).toBe(false);
  });
});

// Switching provider used to leave five model ids belonging to the vendor just
// left, so the next compile failed on every source until they were retyped.
describe("model ids follow the provider, without discarding what was typed", () => {
  it("swaps a whole untouched map, both directions", () => {
    const toOpenai = modelsForProvider(DEFAULT_SETTINGS.models, "anthropic", "openai-compatible");
    expect(toOpenai).toEqual(DEFAULT_OPENAI_MODELS);

    const andBack = modelsForProvider(toOpenai, "openai-compatible", "anthropic");
    expect(andBack).toEqual(DEFAULT_ANTHROPIC_MODELS);
  });

  it("keeps an id the user typed, and swaps the ones beside it", () => {
    // The whole point of the per-field test: a switch is not consent to
    // discard work. A blanket overwrite passes the case above and fails this.
    const edited = { ...DEFAULT_SETTINGS.models, synthesis: "claude-opus-5" };

    const next = modelsForProvider(edited, "anthropic", "openai-compatible");

    expect(next.synthesis).toBe("claude-opus-5");
    expect(next.inventory).toBe(DEFAULT_OPENAI_MODELS.inventory);
    expect(next["page-generation"]).toBe(DEFAULT_OPENAI_MODELS["page-generation"]);
  });

  it("leaves a fully hand-typed map alone", () => {
    const mine = Object.fromEntries(PROVIDER_TASKS.map((task) => [task, `my-${task}`])) as Record<
      (typeof PROVIDER_TASKS)[number],
      string
    >;

    expect(modelsForProvider(mine, "anthropic", "openai-compatible")).toEqual(mine);
  });

  it("changes nothing when the provider did not change", () => {
    expect(modelsForProvider(DEFAULT_SETTINGS.models, "anthropic", "anthropic")).toEqual(
      DEFAULT_ANTHROPIC_MODELS,
    );
  });

  it("returns a copy, never the caller's object", () => {
    // The settings tab writes into `models` on every keystroke; handing back
    // the same reference would make a switch edit the map it was reading.
    const before = { ...DEFAULT_SETTINGS.models };

    const next = modelsForProvider(before, "anthropic", "openai-compatible");

    expect(next).not.toBe(before);
    expect(before).toEqual(DEFAULT_ANTHROPIC_MODELS);
  });

  it("ships an id for every task on both sides, and they do not overlap", () => {
    for (const task of PROVIDER_TASKS) {
      expect(DEFAULT_OPENAI_MODELS[task]).toMatch(/\S/);
      expect(DEFAULT_ANTHROPIC_MODELS[task]).toMatch(/^claude-/);
      expect(DEFAULT_OPENAI_MODELS[task]).not.toBe(DEFAULT_ANTHROPIC_MODELS[task]);
    }
  });

  it("mutating DEFAULT_SETTINGS.models cannot reach the named set", () => {
    const settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models } };
    settings.models.inventory = "scribbled";

    expect(DEFAULT_ANTHROPIC_MODELS.inventory).toBe("claude-haiku-4-5-20251001");
  });
});
