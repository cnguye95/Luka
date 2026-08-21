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

  plugin.addCommand({
    id: "ask",
    name: "Ask the wiki",
    callback: () => {
      void plugin.runAsk();
    },
  });

  plugin.addCommand({
    id: "health-check",
    name: "Health check",
    callback: () => {
      void plugin.runHealthCheck();
    },
  });

  plugin.addCommand({
    id: "file-answer",
    name: "File this answer",
    // §8.1 scopes this to "active answer note", so the command hides itself
    // rather than failing when the active file is anything else. `checking`
    // asks whether it applies; only the second pass may act.
    checkCallback: (checking: boolean) => {
      const path = plugin.activeAnswerPath();
      if (path === null) return false;
      if (!checking) void plugin.runFileBack(path);
      return true;
    },
  });
}
