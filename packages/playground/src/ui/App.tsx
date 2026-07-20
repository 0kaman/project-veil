/**
 * The REPL. A conversation you keep talking to, with tool calls inline.
 *
 * Committed history goes through Ink's <Static>: each entry is painted once and
 * then belongs to the terminal's own scrollback, so a long session scrolls like
 * a shell instead of repainting a viewport. Only the bottom strip — streaming
 * text, spinner, permission prompt, input — is live.
 */
import React, { useCallback, useEffect, useRef, useState, useReducer } from "react";
import { Box, Static, Text, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import type { Config } from "../config.js";
import { Tracer } from "../trace.js";
import { VeilMcp } from "../mcp.js";
import { Mistral } from "../mistral.js";
import { AgentSession, type GateDecision } from "../agent.js";
import { Entry } from "./Transcript.js";
import { CHOICES, Permission } from "./Permission.js";
import { num, ms, type Item, type ItemBody } from "./items.js";

const SPINNER = ["✻", "✳", "✶", "✻", "✳", "✢"];
const HELP = "/help · /clear · /auto · /trace · /quit — esc interrupts";

interface Pending {
  name: string;
  args: unknown;
  resolve: (d: GateDecision) => void;
}

export function App({ config, autoExit }: { config: Config; autoExit?: boolean }) {
  const { exit } = useApp();
  // Ink derives this from stdin.isTTY, which is undefined (not false) on a pipe,
  // and useInput only skips when isActive is strictly false.
  const keys = Boolean(useStdin().isRawModeSupported);

  const [items, addItem] = useReducer((s: Item[], i: Item) => [...s, i], []);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState("");
  const [auto, setAuto] = useState(config.auto);
  const [frame, setFrame] = useState(0);
  const [tokens, setTokens] = useState({ up: 0, down: 0 });
  const [ready, setReady] = useState(false);

  const tracerRef = useRef<Tracer | null>(null);
  if (!tracerRef.current) tracerRef.current = new Tracer(config.traceDir);
  const tracer = tracerRef.current;

  const sessionRef = useRef<AgentSession | null>(null);
  const mcpRef = useRef<VeilMcp | null>(null);
  const allowed = useRef(new Set<string>());
  const autoRef = useRef(auto);
  const turnStart = useRef(0);
  const seq = useRef(0);
  const calls = useRef(new Map<string, { name: string; args: unknown }>());

  const say = useCallback((item: ItemBody) => addItem({ ...item, id: `i${seq.current++}` }), []);

  const shutdown = useCallback(
    async (reason = "closed") => {
      tracer.emit({ kind: "run.end", ms: tracer.elapsed(), steps: 0, reason });
      await mcpRef.current?.close();
      tracer.close();
    },
    [tracer],
  );

  // Token counters from the trace bus — same numbers as the JSONL.
  useEffect(
    () =>
      tracer.subscribe((e) => {
        if (e.kind === "llm.response") setTokens((t) => ({ up: t.up + e.promptTokens, down: t.down + e.completionTokens }));
      }),
    [tracer],
  );

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  // Connect once; the server stays up for the whole conversation.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const m = new VeilMcp(config.mcpServerPath, tracer);
      try {
        const tools = await m.connect();
        if (cancelled) return;
        mcpRef.current = m;
        sessionRef.current = new AgentSession({
          tracer,
          mcp: m,
          llm: new Mistral(config.apiKey, config.model, tracer),
          maxSteps: config.maxSteps,
          gate: ({ name, args }) =>
            autoRef.current || allowed.current.has(name)
              ? Promise.resolve<GateDecision>("go")
              : new Promise<GateDecision>((resolve) => {
                  setCursor(0);
                  setPending({
                    name,
                    args,
                    resolve: (d) => {
                      if (d === "always") allowed.current.add(name);
                      setPending(null);
                      resolve(d);
                    },
                  });
                }),
          ui: {
            textDelta: (d) => setStreaming((s) => s + d),
            assistantDone: (text) => {
              setStreaming("");
              say({ kind: "assistant", text });
            },
            toolStart: (t) => {
              calls.current.set(t.id, { name: t.name, args: t.args });
              setStreaming("");
            },
            toolEnd: (t) => {
              const c = calls.current.get(t.id);
              say({ kind: "tool", name: c?.name ?? "tool", args: c?.args ?? {}, result: t.text, ok: t.ok, ms: t.ms, via: t.via });
            },
            note: (text) => say({ kind: "note", text }),
            error: (text) => say({ kind: "error", text }),
          },
        });
        tracer.emit({ kind: "run.start", goal: config.goal ?? "(interactive)", model: config.model, traceFile: tracer.file });
        say({ kind: "banner", model: config.model, tools: tools.map((t) => t.name), trace: tracer.file.split("/").slice(-1)[0] });
        setReady(true);
      } catch (err) {
        say({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, say, tracer]);

  const submit = useCallback(
    async (text: string) => {
      const t = text.trim();
      const session = sessionRef.current;
      if (!t || !session) return;
      setInput("");
      if (t.startsWith("/")) {
        const cmd = t.slice(1).split(/\s+/)[0];
        if (cmd === "quit" || cmd === "exit") {
          await shutdown("quit");
          exit();
        } else if (cmd === "clear") {
          session.reset();
          say({ kind: "note", text: "context cleared" });
        } else if (cmd === "auto") {
          autoRef.current = !autoRef.current;
          setAuto(autoRef.current);
          say({ kind: "note", text: `auto-accept ${autoRef.current ? "on" : "off"}` });
        } else if (cmd === "trace") {
          say({ kind: "note", text: tracer.file });
        } else {
          say({ kind: "note", text: HELP });
        }
        return;
      }
      say({ kind: "user", text: t });
      setBusy(true);
      turnStart.current = Date.now();
      await session.send(t);
      setStreaming("");
      setBusy(false);
      if (autoExit) {
        await shutdown("done");
        exit();
      }
    },
    [autoExit, exit, say, shutdown, tracer],
  );

  // A goal on argv runs as the first turn once MCP is up.
  const started = useRef(false);
  useEffect(() => {
    if (ready && config.goal && !started.current) {
      started.current = true;
      void submit(config.goal);
    }
  }, [ready, config.goal, submit]);

  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "c") {
        void shutdown("ctrl-c").then(() => exit());
        return;
      }
      if (pending) {
        if (key.upArrow) setCursor((c) => (c + CHOICES.length - 1) % CHOICES.length);
        if (key.downArrow) setCursor((c) => (c + 1) % CHOICES.length);
        if (key.return) pending.resolve(CHOICES[cursor].value);
        const n = Number(ch);
        if (n >= 1 && n <= CHOICES.length) pending.resolve(CHOICES[n - 1].value);
        return;
      }
      if (key.escape && busy) sessionRef.current?.interrupt();
    },
    { isActive: keys },
  );

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <Entry key={item.id} item={item} />}</Static>

      {streaming.length > 0 && (
        <Box marginBottom={1}>
          <Text color="magenta">● </Text>
          <Text>{streaming}</Text>
        </Box>
      )}

      {busy && streaming.length === 0 && !pending && (
        <Box>
          <Text color="magenta">{SPINNER[frame % SPINNER.length]} </Text>
          <Text color="gray">Working… ({ms(Date.now() - turnStart.current)} · ↑{num(tokens.up)} tokens · esc to interrupt)</Text>
        </Box>
      )}

      {pending && <Permission name={pending.name} args={pending.args} cursor={cursor} />}

      {!busy && !pending && ready && keys && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="gray">&gt; </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          </Box>
          <Text color="gray" dimColor>
            {auto ? " ⏵⏵ auto-accept" : " ⏵ step mode"} · /help · ↑{num(tokens.up)} ↓{num(tokens.down)}
          </Text>
        </Box>
      )}
    </Box>
  );
}
