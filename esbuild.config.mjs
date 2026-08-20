import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const banner = `/*
Luka — bundled by esbuild from src/plugin/main.ts. Do not edit directly.
*/
`;

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/plugin/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  logLevel: "info",
  banner: { js: banner },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("luka: watching for changes…");
} else {
  await esbuild.build(options);
}
