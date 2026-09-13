import type LukaPlugin from "./main";

/**
 * The commands. Obsidian prefixes the plugin name, so this reads as
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
    id: "open-graph",
    name: "Open graph",
    callback: () => {
      void plugin.openGraph();
    },
  });

  plugin.addCommand({
    id: "show-retrieval",
    name: "Show retrieval on graph",
    // Scoped to an active answer note, the same gating "File this answer"
    // has — so it hides rather than failing on anything else.
    checkCallback: (checking: boolean) => {
      const path = plugin.activeAnswerPath();
      if (path === null) return false;
      if (!checking) void plugin.showRetrievalOnGraph(path);
      return true;
    },
  });

  plugin.addCommand({
    id: "file-answer",
    name: "File this answer",
    // Scoped to the active answer note, so the command hides itself
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
