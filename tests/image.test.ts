import { describe, expect, it } from "vitest";
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

describe("inline image localization (§6.3)", () => {
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
    expect(twice.marked).toBe(0);
  });
});
