// Copies the built plugin into ./test-vault so Obsidian can load it.
// The test vault is gitignored; create it by opening ./test-vault as a vault in Obsidian.
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const dest = path.join(root, "test-vault", ".obsidian", "plugins", "luka");

try {
  await stat(path.join(root, "main.js"));
} catch {
  console.error("main.js not found — run `npm run build` first.");
  process.exit(1);
}

await mkdir(dest, { recursive: true });
// Obsidian loads `styles.css` from the plugin directory on its own, so it has
// to travel with the build — §9's pane has no layout without it.
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(path.join(root, file), path.join(dest, file));
}

console.log(`Installed to ${path.relative(root, dest)}`);
console.log("Open ./test-vault in Obsidian, then enable Luka under Community plugins.");
