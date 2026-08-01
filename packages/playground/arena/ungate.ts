/**
 * Take BOTH contenders' guards down, reproducibly.
 *
 * Why this file exists: rounds 1 and 2 were both voided by gating, and the fix
 * for round 2 was applied BY HAND with `docker exec` and never committed. It
 * survived only inside the `pinchtab-data` volume, so `docs/ARENA.md`'s
 * "reproduce with arena:up && arena:preflight && arena" was not true — a clean
 * checkout would have reproduced round 1's failure, not round 2's result. A
 * benchmark whose configuration lives in a volume is not a benchmark.
 *
 * What it does, and the order matters:
 *
 *   1. `pinchtab security down` — their own documented, first-class preset.
 *      Disables the website whitelist and IDPI. This is NOT us reaching around
 *      their design; it is the switch they ship for exactly this.
 *   2. Trust the arena network's CIDR. MEASURED: step 1 alone is not enough and
 *      fails in the opposite direction — with the whitelist off, the SSRF guard
 *      takes over and `http://fixtures:8080/spa` returns
 *      `Error 403: navigation target resolves to blocked private/internal IP`,
 *      because the fixture host is a private Docker address that the old
 *      allowlist used to cover. Disabling one guard exposed another. Left
 *      unchecked that would have voided all five fixture tasks — the same class
 *      of error as rounds 1 and 2, in the opposite direction.
 *   3. Restart, because the running server holds the config it booted with.
 *   4. PROVE it with live navigations, internal and external. A config file
 *      saying "disabled" is not evidence; a page that loads is.
 *
 * Veil needs no equivalent step: it has no domain allowlist and no content
 * gate. Its one security boundary (`veil_replay`, default `safe`) is checked
 * here too and reported, so "Veil was ungated" is a measurement rather than an
 * assumption. No arena task uses replay.
 *
 * This LOWERS the security posture of a container on your machine. That is the
 * point — an ungated comparison — and it is why it is a separate, explicit,
 * loud step rather than something folded silently into `arena:up`.
 *
 *   pnpm --filter @veil/playground arena:ungate
 */
import { execFileSync } from "node:child_process";

const say = (s: string) => process.stdout.write(s + "\n");
const ok = (s: string) => say(`  ✓ ${s}`);
const bad = (s: string) => say(`  ✗ ${s}`);

function sh(cmd: string, args: string[], timeout = 120_000): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `ERR:${(e.stdout ?? "") + (e.stderr ?? "") || e.message || String(err)}`;
  }
}

const pt = (...args: string[]): string => sh("docker", ["exec", "arena-pinchtab", ...args]);

/** Navigate and report whether it was refused. Returns null on success. */
function navBlocked(url: string): string | null {
  const out = sh("docker", [
    "exec",
    "arena-pinchtab",
    "sh",
    "-lc",
    `pinchtab nav ${JSON.stringify(url)} 2>&1`,
  ]);
  return /error|blocked|not in allowlist|refused|403/i.test(out) ? out.split("\n")[0]!.slice(0, 90) : null;
}

async function main(): Promise<void> {
  say("\n  ARENA · GUARDS DOWN\n");
  say("  This lowers a container's security posture on purpose, so that neither");
  say("  contender is measured through a gate the other does not have.\n");

  let fatal = 0;

  // ── the network the fixtures actually live on ────────────────────────────
  // Read it rather than hardcoding: compose picks the subnet, and it moves.
  const subnet = sh("docker", [
    "network",
    "inspect",
    "veil-arena_arena",
    "--format",
    "{{range .IPAM.Config}}{{.Subnet}}{{end}}",
  ]);
  if (subnet.startsWith("ERR:") || !/\d+\.\d+\.\d+\.\d+\/\d+/.test(subnet)) {
    bad(`cannot read the arena network subnet (${subnet.slice(0, 60)}) — is arena:up done?`);
    process.exit(1);
  }
  ok(`arena network ${subnet}`);

  // ── 1. their own preset ──────────────────────────────────────────────────
  const down = pt("pinchtab", "security", "down");
  if (down.startsWith("ERR:")) {
    bad(`pinchtab security down failed: ${down.slice(0, 120)}`);
    fatal++;
  } else ok("pinchtab security down — website whitelist + IDPI disabled");

  // ── 2. the guard that only APPEARS once the whitelist is off ─────────────
  const cidr = pt("pinchtab", "config", "set", "security.trustedResolveCIDRs", subnet);
  if (cidr.startsWith("ERR:")) {
    bad(`could not trust ${subnet}: ${cidr.slice(0, 120)}`);
    fatal++;
  } else ok(`trustedResolveCIDRs = ${subnet} (or the fixtures are 403 private-IP)`);

  // ── 3. the running server holds the config it booted with ────────────────
  sh("docker", ["restart", "arena-pinchtab"], 180_000);
  await new Promise((r) => setTimeout(r, 12_000));
  ok("pinchtab restarted");

  // ── 4. evidence, not configuration ───────────────────────────────────────
  say("");
  const probes: Array<[string, string]> = [
    ["fixtures (private IP)", "http://fixtures:8080/spa"],
    ["wikipedia (read tier)", "https://en.wikipedia.org/wiki/HTTP"],
    ["nasa.gov (blocked 6/6 in round 2)", "https://www.nasa.gov"],
    ["github (mixed task)", "https://github.com/pinchtab/pinchtab"],
  ];
  for (const [label, url] of probes) {
    const blocked = navBlocked(url);
    if (blocked) {
      bad(`${label.padEnd(34)} BLOCKED — ${blocked}`);
      fatal++;
    } else ok(`${label.padEnd(34)} reachable`);
  }

  // Content, not just a tab id: `nav` hands back a tab even when the page is
  // empty, and "it navigated" is not "it loaded".
  const text = sh("docker", [
    "exec",
    "arena-pinchtab",
    "sh",
    "-lc",
    "pinchtab nav http://fixtures:8080/spa >/dev/null 2>&1; sleep 2; pinchtab text 2>/dev/null",
  ]);
  if (/Sprocket/i.test(text) && /1250/.test(text)) {
    ok("fixture CONTENT verified (Sprocket · 1250 — the spa task's own answer)");
  } else {
    bad(`fixture text did not contain the expected answer: ${text.slice(0, 80)}`);
    fatal++;
  }

  // ── Veil's side, stated rather than assumed ──────────────────────────────
  say("");
  const replay = sh("docker", [
    "exec",
    "arena-veil",
    "sh",
    "-lc",
    "printf %s \"${VEIL_REPLAY:-safe}\"",
  ]);
  ok(`veil has no domain allowlist and no content gate (replay mode: ${replay || "safe"})`);
  say("      no arena task uses veil_replay, so that boundary does not bind here.");

  say(
    fatal === 0
      ? "\n  BOTH CONTENDERS UNGATED. Next: arena:preflight, then arena.\n"
      : `\n  ${fatal} problem(s) above — do NOT run the arena; the result would be void.\n`,
  );
  process.exit(fatal === 0 ? 0 : 1);
}

void main();
