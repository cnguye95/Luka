// Inline image localization: the header-byte dimension sniff, the keep-or-mark
// decision for a remote image, and the marker idiom, which has to replace
// itself on a second pass rather than stack.
import { describe, expect, it, vi } from "vitest";
import type { HttpAdapter } from "../src/core/adapters";
import { localizeInlineImages, sniffImageSize } from "../src/core/normalize/image";
import {
  gifBytes,
  jpegBytes,
  pngBytes,
  webpVp8Bytes,
  webpVp8lBytes,
  webpVp8xBytes,
} from "./helpers/images";
import { StubHttp, type StubRoute } from "./helpers/http";
import { MemFs } from "./helpers/memfs";

const PNG_HEADERS = { "content-type": "image/png" };

function run(text: string, routes: Record<string, StubRoute>) {
  const fs = new MemFs();
  const http = new StubHttp(routes);
  return localizeInlineImages(text, { fs, http, timeoutMs: 1000 }).then((result) => ({
    ...result,
    fs,
    http,
  }));
}

describe("dimension sniffing (header bytes only, no decode)", () => {
  it("reads every supported container", () => {
    expect(sniffImageSize(pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
    expect(sniffImageSize(gifBytes(300, 200))).toEqual({ width: 300, height: 200 });
    expect(sniffImageSize(jpegBytes(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(sniffImageSize(webpVp8xBytes(800, 600))).toEqual({ width: 800, height: 600 });
    expect(sniffImageSize(webpVp8Bytes(320, 240))).toEqual({ width: 320, height: 240 });
    expect(sniffImageSize(webpVp8lBytes(150, 120))).toEqual({ width: 150, height: 120 });
  });

  it("returns null for anything it cannot read", () => {
    expect(sniffImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(null);
  });
});

describe("inline image localization", () => {
  it("writes a kept image to raw/assets and rewrites the link", async () => {
    const result = await run("Figure below.\n\n![diagram](https://ex.com/fig1.png)\n", {
      "https://ex.com/fig1.png": { headers: PNG_HEADERS, bytes: pngBytes(600, 400) },
    });

    const asset = result.fs.paths().find((p) => p.startsWith("raw/assets/"));
    expect(asset).toMatch(/^raw\/assets\/[0-9a-f]{64}\.png$/);
    expect(result.text).toContain(`![diagram](${asset})`);
    expect(result.text).not.toContain("https://ex.com/fig1.png");
    expect(result.localized).toBe(1);
    expect(result.marked).toBe(0);
  });

  it("leaves local paths and data: URIs untouched and never fetches them", async () => {
    const text = "![a](raw/assets/x.png)\n![b](data:image/png;base64,AAAA)\n![c](./rel.png)\n";
    const result = await run(text, {});
    expect(result.text).toBe(text);
    expect(result.http.requests).toEqual([]);
  });

  it("marks an HTTP failure and keeps the remote link", async () => {
    const result = await run("![fig3](https://ex.com/fig3.png)\n", {
      "https://ex.com/fig3.png": { status: 404 },
    });
    expect(result.text).toContain("![fig3](https://ex.com/fig3.png)");
    expect(result.text).toContain("<!-- image not fetched: fig3.png — fetch failed, HTTP 404 -->");
    expect(result.marked).toBe(1);
  });

  it("marks a network failure with a stable reason", async () => {
    const result = await run("![fig](https://ex.com/a.png)\n", {});
    expect(result.text).toContain("— fetch failed, network error -->");
  });

  it("rejects a non-image content-type", async () => {
    const result = await run("![fig](https://ex.com/page.png)\n", {
      "https://ex.com/page.png": {
        headers: { "content-type": "text/html; charset=utf-8" },
        bytes: pngBytes(600, 400),
      },
    });
    expect(result.text).toContain("not an image, content-type text/html");
  });

  it("rejects an image under 100x100", async () => {
    const result = await run("![fig](https://ex.com/tiny.png)\n", {
      "https://ex.com/tiny.png": { headers: PNG_HEADERS, bytes: pngBytes(50, 50, 20_000) },
    });
    expect(result.text).toContain("— under 100×100 -->");
  });

  it("keeps a banner that is small in only one dimension (uncertain, so keep)", async () => {
    const result = await run("![fig](https://ex.com/banner.png)\n", {
      "https://ex.com/banner.png": { headers: PNG_HEADERS, bytes: pngBytes(900, 60, 20_000) },
    });
    expect(result.localized).toBe(1);
    expect(result.marked).toBe(0);
  });

  it("rejects an image under 5KB", async () => {
    const result = await run("![fig](https://ex.com/small.png)\n", {
      "https://ex.com/small.png": { headers: PNG_HEADERS, bytes: pngBytes(600, 400, 2_000) },
    });
    expect(result.text).toContain("— under 5KB -->");
  });

  it("rejects a decorative name the prose never mentions", async () => {
    const result = await run("Some prose.\n\n![](https://ex.com/site-logo.png)\n", {
      "https://ex.com/site-logo.png": { headers: PNG_HEADERS, bytes: pngBytes(600, 400) },
    });
    expect(result.text).toContain("decorative name, unreferenced in prose");
  });

  it("keeps a decorative name the prose does mention (tiebreak keeps)", async () => {
    const result = await run(
      "The site-logo is discussed at length here.\n\n![](https://ex.com/site-logo.png)\n",
      { "https://ex.com/site-logo.png": { headers: PNG_HEADERS, bytes: pngBytes(600, 400) } },
    );
    expect(result.localized).toBe(1);
  });

  it("keeps an unrecognisable format rather than guessing (uncertain, so keep)", async () => {
    const result = await run("![fig](https://ex.com/odd)\n", {
      "https://ex.com/odd": {
        headers: { "content-type": "image/x-unknown" },
        bytes: new Uint8Array(9000).fill(7),
      },
    });
    expect(result.localized).toBe(1);
    expect(result.fs.paths()[0]).toMatch(/\.xunknown$/);
  });

  it("fetches each distinct URL once no matter how often it appears", async () => {
    const result = await run(
      "![a](https://ex.com/f.png)\n\n![b](https://ex.com/f.png)\n",
      { "https://ex.com/f.png": { headers: PNG_HEADERS, bytes: pngBytes(600, 400) } },
    );
    expect(result.http.requests).toEqual(["https://ex.com/f.png"]);
    expect(result.localized).toBe(2);
  });

  it("does not stack a second marker when the source is processed again", async () => {
    const routes = { "https://ex.com/x.png": { status: 500 } };
    const once = await run("![x](https://ex.com/x.png)\n", routes);
    const twice = await run(once.text, routes);
    expect(twice.text).toBe(once.text);
  });

  it("replaces the marker rather than stacking one when the reason changes", async () => {
    const once = await run("![x](https://ex.com/x.png)\n", {
      "https://ex.com/x.png": { status: 404 },
    });
    const twice = await run(once.text, { "https://ex.com/x.png": { status: 500 } });

    expect(twice.text).toContain("HTTP 500");
    expect(twice.text).not.toContain("HTTP 404");
    expect(twice.text.match(/image not fetched/g)).toHaveLength(1);
  });

  it("drops a stale marker once the image can be fetched", async () => {
    const failed = await run("![x](https://ex.com/x.png)\n", {
      "https://ex.com/x.png": { status: 503 },
    });
    expect(failed.text).toContain("image not fetched");

    const recovered = await run(failed.text, {
      "https://ex.com/x.png": { headers: PNG_HEADERS, bytes: pngBytes(600, 400) },
    });
    expect(recovered.text).not.toContain("image not fetched");
    expect(recovered.localized).toBe(1);
  });

  it("fetches at most four images at once (fixed concurrency)", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const gated: HttpAdapter = {
      async request() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return { status: 404, headers: {}, bytes: new Uint8Array() };
      },
    };

    const text = Array.from({ length: 6 }, (_, i) => `![f${i}](https://ex.com/f${i}.png)`).join(
      "\n\n",
    );
    const pending = localizeInlineImages(text, { fs: new MemFs(), http: gated, timeoutMs: 1000 });

    let released = 0;
    while (released < 6) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      (release.shift() as () => void)();
      released += 1;
    }

    const result = await pending;
    expect(peak).toBe(4);
    expect(result.marked).toBe(6);
  });

  it("preserves comments it did not write", async () => {
    const result = await run(
      "![x](https://ex.com/x.png)\n<!-- my own note -->\n",
      { "https://ex.com/x.png": { status: 404 } },
    );
    expect(result.text).toContain("<!-- my own note -->");
  });
});
