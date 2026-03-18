let verbose = false;

export const log = {
  setVerbose(v: boolean) {
    verbose = v;
  },
  info(...args: unknown[]) {
    console.log(...args);
  },
  warn(...args: unknown[]) {
    console.warn(...args);
  },
  error(...args: unknown[]) {
    console.error(...args);
  },
  debug(...args: unknown[]) {
    if (verbose) {
      console.debug('[debug]', ...args);
    }
  },
  trace(...args: unknown[]) {
    if (verbose) {
      console.debug('[trace]', ...args);
    }
  },
};
