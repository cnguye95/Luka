import { describe, expect, it } from "vitest";
import { ObsidianFs } from "../src/plugin/fs-obsidian";

// `fs-obsidian.ts` only `import type`s from obsidian, so the adapter it wraps
// can be stubbed and its behaviour asserted without a host. The rest of
// src/plugin needs a running Obsidian and stays on the manual checklist.
interface Node {
  kind: "file" | "folder";
}

class StubAdapter {
  readonly calls: string[] = [];
  constructor(readonly nodes = new Map<string, Node>()) {}

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(path);
  }
  async stat(path: string): Promise<{ type: "file" | "folder"; size: number } | null> {
    const node = this.nodes.get(path);
    return node === undefined ? null : { type: node.kind, size: 0 };
  }
  async mkdir(path: string): Promise<void> {
    if (this.nodes.has(path)) throw new Error(`EEXIST: ${path}`);
    this.calls.push(`mkdir ${path}`);
    this.nodes.set(path, { kind: "folder" });
  }
  async remove(path: string): Promise<void> {
    this.calls.push(`remove ${path}`);
    this.nodes.delete(path);
  }
  async trashSystem(path: string): Promise<boolean> {
    this.calls.push(`trashSystem ${path}`);
    this.nodes.delete(path);
    return true;
  }
  async trashLocal(path: string): Promise<void> {
    this.calls.push(`trashLocal ${path}`);
    this.nodes.delete(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const files = [...this.nodes]
      .filter(([p, n]) => n.kind === "file" && p.startsWith(`${path}/`))
      .map(([p]) => p);
    return { files, folders: [] };
  }
}

const fsOver = (adapter: StubAdapter) => new ObsidianFs(adapter as never);

describe("deleting goes through Obsidian's recovery path", () => {
  it("trashes rather than unlinking", async () => {
    // What comes through here is a cascade-doomed page — the modal calls them
    // pages that *may* be deleted, so the user approves a superset — and
    // derivatives under raw/, including one a user hand-repaired, which §6.2
    // names as the sanctioned repair. `remove()` puts those beyond recovery.
    const adapter = new StubAdapter(new Map([["wiki/concepts/Gone.md", { kind: "file" }]]));

    await fsOver(adapter).delete("wiki/concepts/Gone.md");

    expect(adapter.calls).toEqual(["trashSystem wiki/concepts/Gone.md"]);
    expect(adapter.calls.some((c) => c.startsWith("remove"))).toBe(false);
  });

  it("falls back to the vault's own trash where the platform has none", async () => {
    const adapter = new StubAdapter(new Map([["raw/paper.md", { kind: "file" }]]));
    adapter.trashSystem = async () => false;

    await fsOver(adapter).delete("raw/paper.md");

    expect(adapter.calls).toEqual(["trashLocal raw/paper.md"]);
  });
});

describe("mkdir survives what §6.3's concurrency does to it", () => {
  it("treats a folder another worker just created as success", async () => {
    // §6.3 fetches four images at once, so on the first compile of a document
    // with two kept remote images every in-flight call sees raw/assets absent.
    // The throw escaped to normalizeSource and failed the whole source, where
    // §6.3 says a failure should leave the link and mark it.
    const adapter = new StubAdapter();
    const racing = new ObsidianFs(adapter as never);

    const results = await Promise.allSettled([
      racing.mkdir("raw/assets"),
      racing.mkdir("raw/assets"),
      racing.mkdir("raw/assets"),
      racing.mkdir("raw/assets"),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("still surfaces a file standing where a folder belongs", async () => {
    const adapter = new StubAdapter(new Map([["raw/assets", { kind: "file" }]]));

    await expect(fsOver(adapter).mkdir("raw/assets")).rejects.toThrow();
  });
});

describe("listing agrees with core's ordering", () => {
  it("orders by code unit, not by locale", async () => {
    const adapter = new StubAdapter(
      new Map<string, Node>([
        ["raw", { kind: "folder" }],
        ["raw/_x.md", { kind: "file" }],
        ["raw/a.md", { kind: "file" }],
        ["raw/B.md", { kind: "file" }],
      ]),
    );

    const listed = await fsOver(adapter).list("raw");

    expect(listed.map((e) => e.path)).toEqual(["raw/B.md", "raw/_x.md", "raw/a.md"]);
  });
});

describe("the trash fallback covers a host that rejects", () => {
  it("still reaches the vault's own trash when trashSystem throws", async () => {
    // Documented to answer false where there is no usable system trash, but a
    // sandboxed host can reject instead — and a rejection that skipped the
    // fallback would leave the file in place with no second attempt.
    const adapter = new StubAdapter(new Map([["raw/paper.md", { kind: "file" }]]));
    adapter.trashSystem = async () => {
      throw new Error("EPERM: no system trash here");
    };

    await fsOver(adapter).delete("raw/paper.md");

    expect(adapter.calls).toEqual(["trashLocal raw/paper.md"]);
  });
});
