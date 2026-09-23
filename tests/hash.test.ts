// `src/core/hash`: SHA-256 against known vectors, and the UTF-8 helpers the
// manifest's hashes are computed over.
import { describe, expect, it } from "vitest";
import { concatBytes, decodeUtf8, sha256Hex, utf8 } from "../src/core/hash";

describe("hash", () => {
  it("matches the known SHA-256 of the empty input and of 'abc'", () => {
    return Promise.all([
      expect(sha256Hex(new Uint8Array())).resolves.toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
      expect(sha256Hex("abc")).resolves.toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ),
    ]);
  });

  it("hashes strings and their bytes identically", async () => {
    expect(await sha256Hex("hello")).toBe(await sha256Hex(utf8("hello")));
  });

  it("round-trips utf8 including non-ASCII", () => {
    expect(decodeUtf8(utf8("café — ok"))).toBe("café — ok");
  });

  it("concatenates in order", () => {
    expect(decodeUtf8(concatBytes([utf8("a"), utf8("bc"), utf8("d")]))).toBe("abcd");
    expect(concatBytes([]).length).toBe(0);
  });
});
