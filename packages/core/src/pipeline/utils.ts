export const FRAMEWORK_PATTERNS = [
  /node_modules/,
  /react-dom/,
  /react\.development/,
  /react\.production/,
  /webpack/,
  /babel/,
  /regenerator-runtime/,
  /tslib/,
  /zone\.js/,
  /angular/,
  /vue\.runtime/,
  /jquery/,
  /scheduler/,
  /chunk-vendors/,
];

export function isFrameworkFrame(url: string): boolean {
  return FRAMEWORK_PATTERNS.some((p) => p.test(url));
}

/**
 * Parse a Chrome Error().stack string into an array of "url:line:col" tuples.
 * Skips anonymous frames and frames without URLs.
 */
export function parseStackFrames(stack: string): string[] {
  if (!stack) return [];

  const frames: string[] = [];
  const lines = stack.split("\n");

  for (const line of lines) {
    // Chrome format: "    at functionName (url:line:col)" or "    at url:line:col"
    const match = line.match(/at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!match) continue;

    const url = match[1];
    // Skip anonymous, eval, and extension frames
    if (
      !url ||
      url === "<anonymous>" ||
      url.startsWith("eval") ||
      url.startsWith("chrome-extension://")
    ) {
      continue;
    }

    frames.push(`${url}:${match[2]}:${match[3]}`);
  }

  return frames;
}

export function extractPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
