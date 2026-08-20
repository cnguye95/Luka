import type LukaPlugin from "./main";

/**
 * handoff.md §8.1. Obsidian prefixes the plugin name, so this reads as
 * "Luka: Compile" in the command palette. Everything Luka does runs from an
 * explicit invocation — there are no watchers and no timers (invariant 1).
 */
export function registerCommands(plugin: LukaPlugin): void {
  plugin.addCommand({
    id: "compile",
    name: "Compile",
    callback: () => {
      void plugin.runCompile();
    },
  });
}
