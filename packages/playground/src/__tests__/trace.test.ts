/**
 * The prompt has to survive the trace intact.
 *
 * A run skipped two thirds of a 16-step script and there was no way to tell
 * "the model ignored the instructions" from "the terminal mangled the paste",
 * because `llm.request` recorded only `messages.length`. The user turn is now
 * traced verbatim — which is only useful if a long, multi-line, quote-bearing
 * prompt round-trips through JSONL unchanged.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../trace.js";

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "veil-trace-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** close() ends the stream but the flush is async — wait for the bytes. */
async function readBack(t: Tracer): Promise<Array<Record<string, unknown>>> {
  t.close();
  for (let i = 0; i < 100; i++) {
    if (existsSync(t.file) && readFileSync(t.file, "utf8").trim().length > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return readFileSync(t.file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("tracing the user turn", () => {
  it("round-trips a long multi-line prompt byte for byte", async () => {
    const prompt = [
      "You are running a full smoke test.",
      "",
      '1. Quote the tool\'s first line, the one starting "via:", exactly.',
      "2. Do not skip steps — even the ones that fail.",
      "\ttabbed, and a backslash \\ and a brace } for good measure",
      "16. Finish with a plain summary.",
    ].join("\n");

    const t = new Tracer(scratch());
    t.emit({ kind: "user", step: 1, chars: prompt.length, text: prompt });

    const rows = await readBack(t);
    const user = rows.find((r) => r.kind === "user")!;
    expect(user).toBeDefined();
    // the whole thing, not a preview
    expect(user.text).toBe(prompt);
    expect(user.chars).toBe(prompt.length);
    // and the newlines did not split it into several JSONL records
    expect(rows).toHaveLength(1);
  });

  it("records the size, so a truncated paste is visible at a glance", async () => {
    const t = new Tracer(scratch());
    t.emit({ kind: "user", step: 1, chars: 4, text: "abcd" });
    expect((await readBack(t))[0]!.chars).toBe(4);
  });
});
