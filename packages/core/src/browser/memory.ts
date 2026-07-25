/**
 * Measuring OUR browser's memory — the control variable for the session pool.
 *
 * The session model budgets on RSS, not session count, because a tab costs
 * 396 MB on average with 24× variance (78 MB for a login form, 1,877 MB for one
 * news site). A fixed cap is meaningless against that spread.
 *
 * IMPORTANT: this walks the process tree from OUR spawned browser pid. The
 * design probe took a shortcut — `ps | grep chrome` — which would also sum the
 * user's own Chrome windows and evict our sessions because they have 50 tabs
 * open. Measure only what we launched.
 */
import { execFile } from "node:child_process";
import { debugLog } from "../debug.js";

interface Proc {
  pid: number;
  ppid: number;
  rssKb: number;
}

function snapshot(): Promise<Proc[]> {
  return new Promise((resolve) => {
    // -A: all processes. Portable across macOS and Linux.
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        debugLog("memory: ps failed", err);
        resolve([]);
        return;
      }
      const out: Proc[] = [];
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (m) out.push({ pid: +m[1], ppid: +m[2], rssKb: +m[3] });
      }
      resolve(out);
    });
  });
}

/**
 * Total resident memory of the browser process tree rooted at `rootPid`, in MB.
 * Returns -1 when it can't be determined — callers must treat that as "unknown"
 * and NOT as "zero", or eviction would never fire.
 */
export async function browserTreeRssMb(rootPid: number): Promise<number> {
  const procs = await snapshot();
  if (procs.length === 0) return -1;

  const byParent = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid);
    if (list) list.push(p);
    else byParent.set(p.ppid, [p]);
  }

  let totalKb = 0;
  let found = false;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = procs.find((p) => p.pid === pid);
    if (self) {
      totalKb += self.rssKb;
      found = true;
    }
    for (const child of byParent.get(pid) ?? []) stack.push(child.pid);
  }

  // The root pid being gone means the browser died; that's unknown, not zero.
  if (!found) return -1;
  return Math.round(totalKb / 1024);
}
