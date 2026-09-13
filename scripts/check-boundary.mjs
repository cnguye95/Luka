// Enforces invariant 6: nothing under src/core/ imports `obsidian`.
// Exits non-zero listing every offending file:line.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..", "src", "core");

const PATTERNS = [
  /\bfrom\s*["']obsidian(?:\/[^"']*)?["']/,
  /\brequire\s*\(\s*["']obsidian(?:\/[^"']*)?["']\s*\)/,
  /\bimport\s*\(\s*["']obsidian(?:\/[^"']*)?["']\s*\)/,
  /\bimport\s+["']obsidian(?:\/[^"']*)?["']/,
];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = await walk(ROOT);
const offenders = [];

for (const file of files) {
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (PATTERNS.some((p) => p.test(line))) {
      offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error("Boundary violation — src/core must not import `obsidian`:");
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log(`check:boundary ok — ${files.length} file(s) in src/core, no obsidian imports.`);
