// Minimal, header-accurate image fixtures. Only the bytes the dimension
// sniffer reads are real; the remainder is padding to reach a target size.

function pad(header: readonly number[], totalSize: number): Uint8Array {
  const out = new Uint8Array(Math.max(header.length, totalSize));
  out.set(header, 0);
  // Non-zero filler so the padding cannot be mistaken for a truncated file.
  for (let i = header.length; i < out.length; i++) out[i] = (i % 251) + 1;
  return out;
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function pngBytes(width: number, height: number, totalSize = 6000): Uint8Array {
  return pad(
    [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...be32(13),
      ...ascii("IHDR"),
      ...be32(width),
      ...be32(height),
      8, 6, 0, 0, 0,
    ],
    totalSize,
  );
}

export function gifBytes(width: number, height: number, totalSize = 6000): Uint8Array {
  return pad([...ascii("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0], totalSize);
}

export function jpegBytes(width: number, height: number, totalSize = 6000): Uint8Array {
  return pad(
    [
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      ...be16(17), // segment length
      8, // sample precision
      ...be16(height),
      ...be16(width),
      3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    ],
    totalSize,
  );
}

export function webpVp8xBytes(width: number, height: number, totalSize = 6000): Uint8Array {
  return pad(
    [
      ...ascii("RIFF"),
      ...le32(totalSize - 8),
      ...ascii("WEBP"),
      ...ascii("VP8X"),
      ...le32(10),
      0, // flags
      0, 0, 0, // reserved
      ...le24(width - 1),
      ...le24(height - 1),
    ],
    totalSize,
  );
}

export function webpVp8Bytes(width: number, height: number, totalSize = 6000): Uint8Array {
  return pad(
    [
      ...ascii("RIFF"),
      ...le32(totalSize - 8),
      ...ascii("WEBP"),
      ...ascii("VP8 "),
      ...le32(totalSize - 20),
      0, 0, 0, // frame tag
      0x9d, 0x01, 0x2a, // sync code
      ...le16(width),
      ...le16(height),
    ],
    totalSize,
  );
}

export function webpVp8lBytes(width: number, height: number, totalSize = 6000): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return pad(
    [
      ...ascii("RIFF"),
      ...le32(totalSize - 8),
      ...ascii("WEBP"),
      ...ascii("VP8L"),
      ...le32(totalSize - 20),
      0x2f,
      ...le32(packed),
    ],
    totalSize,
  );
}
