// SHA-256 over bytes (handoff.md §6.2 — timestamps are never used) plus the
// byte/text helpers that go with it. WebCrypto is a global in Node >= 20 and in
// the Electron renderer, so src/core needs no `node:` imports.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
