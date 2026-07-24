/**
 * Debug channel — silent by default, stderr when VEIL_DEBUG is set.
 *
 * The engine deliberately degrades instead of crashing (a flaky CDP call must
 * not kill a render), but degradation must not be invisible: every intentional
 * swallow reports here. Same contract as the read/search receipts, one layer
 * down.
 */
const enabled = !!process.env.VEIL_DEBUG;

export function debugLog(...args: unknown[]): void {
  if (!enabled) return;
  const parts = args.map((a) =>
    a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a),
  );
  process.stderr.write(`[veil] ${parts.join(" ")}\n`);
}
