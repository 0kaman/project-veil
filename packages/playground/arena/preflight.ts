/**
 * Arena preflight — verify everything without spending a single token.
 *
 * Run this before the war starts. It checks Docker, both containers, that the
 * fixtures are reachable FROM INSIDE each contender, and that both MCP servers
 * hand over a tool list on stdio.
 *
 * It also produces the one result that needs no LLM at all: the **tool-schema
 * cost**. Every request re-sends every tool schema, so a surface with 38 tools
 * pays that on every single turn before the agent has done anything. That is a
 * real, structural token cost and worth knowing up front.
 *
 *   pnpm --filter @veil/playground arena:preflight
 */
import { execFileSync } from "node:child_process";
import { Tracer } from "../src/trace.js";
import { VeilMcp } from "../src/mcp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/config.js";

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;
const say = (s: string) => process.stdout.write(s + "\n");

const CONTENDERS = [
  {
    name: "veil",
    container: "arena-veil",
    spawn: {
      command: "docker",
      args: ["exec", "-i", "arena-veil", "node", "/app/packages/mcp/dist/server.js"],
    },
  },
  {
    name: "pinchtab",
    container: "arena-pinchtab",
    spawn: { command: "docker", args: ["exec", "-i", "arena-pinchtab", "pinchtab", "mcp"] },
  },
];

function sh(cmd: string, args: string[], timeout = 20_000): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout }).trim();
  } catch (err) {
    return `ERR:${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}

async function main(): Promise<void> {
  // .env is where the keys live; without this the documented command exits 1
  // on a machine that has them, which reads as a missing key rather than a
  // missing loader.
  loadEnv();
  let fatal = 0;
  say("\n  ARENA PREFLIGHT\n");

  // ── docker ───────────────────────────────────────────────────────────────
  const info = sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.startsWith("ERR:")) {
    say(bad("docker daemon is not running — start Docker Desktop, then re-run"));
    fatal++;
  } else say(ok(`docker daemon ${info}`));

  // ── containers ───────────────────────────────────────────────────────────
  if (!fatal) {
    const ps = sh("docker", ["ps", "--format", "{{.Names}}\t{{.Status}}"]);
    for (const c of ["arena-fixtures", ...CONTENDERS.map((c) => c.container)]) {
      const line = ps.split("\n").find((l) => l.startsWith(c));
      if (line) say(ok(`${c.padEnd(16)} ${line.split("\t")[1]}`));
      else {
        say(bad(`${c} is not running — run: pnpm --filter @veil/playground arena:up`));
        fatal++;
      }
    }
  }

  // ── fixtures reachable from INSIDE each contender ───────────────────────
  if (!fatal) {
    say("");
    for (const c of CONTENDERS) {
      const out = sh("docker", [
        "exec",
        c.container,
        "sh",
        "-lc",
        // node is present in both images; curl is not. Use whatever exists.
        "(command -v curl >/dev/null && curl -s -m 5 http://fixtures:8080/health) || " +
          "(command -v wget >/dev/null && wget -qO- http://fixtures:8080/health) || " +
          "(command -v node >/dev/null && node -e \"fetch('http://fixtures:8080/health')" +
          ".then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))\") || echo NOTOOL",
      ]);
      if (out === "ok") say(ok(`${c.name.padEnd(9)} can reach fixtures`));
      else if (out === "NOTOOL") say(`  ~ ${c.name.padEnd(9)} no curl/wget in image — will verify via the task run`);
      else {
        say(bad(`${c.name} cannot reach fixtures (${out.slice(0, 60)})`));
        fatal++;
      }
    }
  }

  // ── secrets actually INSIDE the contender ───────────────────────────────
  // Compose interpolates ${VAR} from the shell, so an unexported key yields an
  // empty string and the container starts perfectly happily with a dead tier.
  // That is exactly what happened on the first full run: Veil's search rung was
  // disabled for all 80 runs and two tasks were scored against it.
  if (!fatal) {
    say("");
    const n = sh("docker", [
      "exec",
      "arena-veil",
      "sh",
      "-lc",
      "printf %s ${#BRAVE_API_KEY}",
    ]);
    if (/^[1-9]/.test(n)) say(ok(`veil      BRAVE_API_KEY present in container (${n} chars)`));
    else {
      say(bad("veil      BRAVE_API_KEY is EMPTY in the container — its search tier is dead"));
      say("            fix: pnpm --filter @veil/playground arena:up   (sources .env)");
      fatal++;
    }
  }

  // ── BOTH CONTENDERS UNGATED ─────────────────────────────────────────────
  // The check that did not exist, and its absence is why round 1 was void:
  // PinchTab blocked 36 of 41 runs on its allowlist, and preflight reported
  // READY. Verifying Veil's key while never asking whether the OTHER contender
  // could reach anything is a preflight that only checks its author's side.
  //
  // Two guards, and they fail in OPPOSITE directions, so both are probed live:
  // the website whitelist blocks the open web, and the SSRF/private-IP guard
  // blocks the fixtures. Turning off only the first swaps one void for another.
  if (!fatal) {
    say("");
    const cfg = sh("docker", ["exec", "arena-pinchtab", "sh", "-lc", "cat /data/.pinchtab/config.json"]);
    const idpiOff = /"idpi"\s*:\s*\{[^}]*"enabled"\s*:\s*false/s.test(cfg);
    if (idpiOff) say(ok("pinchtab  IDPI disabled"));
    else {
      say(bad("pinchtab  IDPI is ENABLED — it will block domains and the run is void"));
      say("            fix: pnpm --filter @veil/playground arena:ungate");
      fatal++;
    }

    // Live navigation beats a config file. One private, one public — the two
    // guards that can each void the whole suite on their own.
    for (const [label, url] of [
      ["fixtures (private IP)", "http://fixtures:8080/spa"],
      ["open web", "https://www.nasa.gov"],
    ] as Array<[string, string]>) {
      const out = sh("docker", [
        "exec",
        "arena-pinchtab",
        "sh",
        "-lc",
        `pinchtab nav ${JSON.stringify(url)} 2>&1`,
      ], 90_000);
      if (/error|blocked|not in allowlist|refused|403/i.test(out)) {
        say(bad(`pinchtab  CANNOT reach ${label} — ${out.split("\n")[0]!.slice(0, 70)}`));
        say("            fix: pnpm --filter @veil/playground arena:ungate");
        fatal++;
      } else say(ok(`pinchtab  can reach ${label}`));
    }
  }

  // ── MCP handshake + the free result: schema cost ────────────────────────
  if (!fatal) {
    say("");
    const rows: Array<{ name: string; tools: number; tokens: number }> = [];
    for (const c of CONTENDERS) {
      const tracer = new Tracer(mkdtempSync(join(tmpdir(), "arena-pre-")));
      const mcp = new VeilMcp(c.spawn, tracer);
      try {
        const tools = await mcp.connect();
        const tokens = Math.ceil(
          tools.reduce(
            (n, t) =>
              n + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters).length,
            0,
          ) / 4,
        );
        rows.push({ name: c.name, tools: tools.length, tokens });
        say(ok(`${c.name.padEnd(9)} MCP ok — ${tools.length} tools`));
      } catch (err) {
        say(bad(`${c.name} MCP handshake failed: ${err instanceof Error ? err.message.slice(0, 70) : err}`));
        fatal++;
      } finally {
        await mcp.close().catch(() => {});
        tracer.close();
      }
    }

    if (rows.length === 2) {
      say("\n  ── free result: what the tool surface costs on EVERY request ──");
      for (const r of rows) {
        say(`     ${r.name.padEnd(9)} ${String(r.tools).padStart(3)} tools · ~${r.tokens.toLocaleString()} tokens/request`);
      }
      const [a, b] = rows as [typeof rows[0], typeof rows[0]];
      const lo = a.tokens <= b.tokens ? a : b;
      const hi = a.tokens <= b.tokens ? b : a;
      if (lo.tokens > 0) {
        say(
          `     → ${hi.name} carries ${(hi.tokens - lo.tokens).toLocaleString()} more tokens per turn ` +
            `(${(hi.tokens / lo.tokens).toFixed(1)}×) before either agent does anything`,
        );
      }
    }
  }

  // ── key ──────────────────────────────────────────────────────────────────
  say("");
  const key = (process.env.MISTRAL_API_KEY ?? "").trim();
  say(key ? ok(`MISTRAL_API_KEY present (${key.length} chars)`) : `  ~ MISTRAL_API_KEY not set — needed only when the run starts`);

  say(
    fatal === 0
      ? "\n  READY. Start with:  pnpm --filter @veil/playground arena --runs 5\n"
      : `\n  ${fatal} blocking problem(s) above.\n`,
  );
  process.exit(fatal === 0 ? 0 : 1);
}

void main();
