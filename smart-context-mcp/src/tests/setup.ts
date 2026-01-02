const originalWarn = console.warn.bind(console);

console.warn = (...args: any[]) => {
  if (args.length === 1 && typeof args[0] === "string") {
    try {
      const parsed = JSON.parse(args[0]);
      if (parsed?.code === "TOOL_DEPRECATED") {
        return;
      }
    } catch {
      // fall through
    }
  }
  if (args.length >= 1 && typeof args[0] === "string") {
    if (args[0].startsWith("[LanguageConfig] Failed to parse ")) {
      return;
    }
  }
  originalWarn(...args);
};
