/**
 * The REPL. A conversation you keep talking to, with tool calls inline.
 *
 * Committed history goes through Ink's <Static>: each entry is painted once and
 * then belongs to the terminal's own scrollback, so a long session scrolls like
 * a normal shell instead of repainting a viewport. Only the bottom strip —
 * streaming text, spinner, permission prompt, input — is live.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import type { Config } from "../config.js";
import { Tracer } from "../trace.js";
import { EpisodeRecorder } from "../episode.js";
import { VeilMcp } from "../mcp.js";
import { Mistral } from "../mistral.js";
import { AgentSession, type GateDecision } from "../agent.js";
import { Entry } from "./Transcript.js";
import { CHOICES, Permission } from "./Permission.js";
import { ms, num, type Item, type ItemBody } from "./items.js";

const SPINNER = ["✻", "✳", "✶", "✻", "✳", "✢"];
const HELP = "/help · /stats · /trace · /clear · /auto · /quit — esc interrupts, ctrl+r expands last result";

interface Pending {
  name: string;
  args: unknown;
  resolve: (d: GateDecision) => void;
}

export function App({
  config,
  autoExit,
}: {
  config: Config;
  /** Non-interactive: run the argv goal, then shut down cleanly and leave. */
  autoExit?: boolean;
}) {
  const { exit } = useApp();
  // Ink derives this from stdin.isTTY, which is `undefined` (not false) on a
  // pipe — and useInput only skips when isActive is strictly false.
  const keys = Boolean(useStdin().isRawModeSupported);

  const [items, addItem] = useReducer((s: Item[], i: Item) => [...s, i], []);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState("");
  const [auto, setAuto] = useState(config.auto);
  const [expand, setExpand] = useState(false);
  const [frame, setFrame] = useState(0);
  const [tokens, setTokens] = useState({ up: 0, down: 0, ctx: 0 });
  const [ready, setReady] = useState(false);

  const tracerRef = useRef<Tracer | null>(null);
  if (!tracerRef.current) tracerRef.current = new Tracer(config.traceDir);
  const tracer = tracerRef.current;

  // The episode recorder is just another subscriber — it distills this session
  // into traces/episodes.jsonl so it can be compared against every other one.
  const recorderRef = useRef<EpisodeRecorder | null>(null);
  if (!recorderRef.current) {
    recorderRef.current = new EpisodeRecorder(config.traceDir);
    recorderRef.current.attach(tracer);
  }
  const recorder = recorderRef.current;

  const sessionRef = useRef<AgentSession | null>(null);
  const mcpRef = useRef<VeilMcp | null>(null);
  const allowed = useRef(new Set<string>());
  const autoRef = useRef(auto);
  const turnStart = useRef(0);
  const turnCount = useRef(0);
  const seq = useRef(0);
  // toolEnd carries only an id — remember each call's name/args for rendering.
  const calls = useRef(new Map<string, { name: string; args: unknown }>());

  const say = useCallback((item: ItemBody) => {
    addItem({ ...item, id: `i${seq.current++}` });
  }, []);

  const shutdown = useCallback(
    async (reason = "closed") => {
      // Emit BEFORE closing the sink, or the episode.end never reaches disk.
      tracer.emit({ kind: "episode.end", ms: tracer.elapsed(), turns: turnCount.current, reason });
      recorder.finish(reason); // idempotent — a belt-and-braces flush
      await mcpRef.current?.close();
      tracer.close();
    },
    [recorder, tracer],
  );

  // Live token counters come from the trace bus, so what's on screen is what's
  // in the JSONL — the two cannot drift apart.
  useEffect(
    () =>
      tracer.subscribe((e) => {
        if (e.kind === "llm.response") {
          setTokens((t) => ({
            up: t.up + e.promptTokens,
            down: t.down + e.completionTokens,
            ctx: e.promptTokens,
          }));
        }
      }),
    [tracer],
  );

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  // Connect once; the browser stays open for the whole conversation.
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
              say({
                kind: "tool",
                name: c?.name ?? "tool",
                args: c?.args ?? {},
                result: t.text,
                ok: t.ok,
                ms: t.ms,
                nodes: t.nodes,
              });
            },
            note: (text) => say({ kind: "note", text }),
            error: (text) => say({ kind: "error", text }),
          },
        });

        tracer.emit({
          kind: "episode.start",
          model: config.model,
          traceFile: tracer.file,
          episodeId: tracer.file.split("/").slice(-1)[0].replace(".trace.jsonl", ""),
        });
        say({
          kind: "banner",
          model: config.model,
          tools: tools.length,
          trace: tracer.file.split("/").slice(-1)[0],
        });
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
          say({ kind: "note", text: "context cleared (browser session kept)" });
        } else if (cmd === "auto") {
          autoRef.current = !autoRef.current;
          setAuto(autoRef.current);
          say({ kind: "note", text: `auto-accept ${autoRef.current ? "on" : "off"}` });
        } else if (cmd === "stats") {
          say({
            kind: "note",
            text: `tokens ↑${num(tokens.up)} ↓${num(tokens.down)} · context ${num(tokens.ctx)}`,
          });
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
      turnCount.current++;
      await session.send(t);
      setStreaming("");
      setBusy(false);
      if (autoExit) {
        // Close the episode before leaving — exiting here without shutdown is
        // how the first version silently recorded nothing.
        await shutdown("done");
        exit();
      }
    },
    [autoExit, exit, say, shutdown, tokens, tracer],
  );

  // A goal passed on argv runs as the first turn, once MCP is up.
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
        void shutdown().then(() => exit());
        return;
      }
      if (key.ctrl && ch === "r") {
        setExpand((v) => !v);
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

  const lastTool = [...items].reverse().find((i) => i.kind === "tool");

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <Entry key={item.id} item={item} expanded={false} />}</Static>

      {streaming.length > 0 && (
        <Box marginBottom={1}>
          <Text color="magenta">● </Text>
          <Text>{streaming}</Text>
        </Box>
      )}

      {expand && lastTool?.kind === "tool" && (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
          <Text bold color="blue">
            {lastTool.name} — full result ({lastTool.result.length} chars, ctrl+r to close)
          </Text>
          <Text color="gray">{lastTool.result.slice(0, 4000)}</Text>
        </Box>
      )}

      {busy && streaming.length === 0 && !pending && (
        <Box>
          <Text color="magenta">{SPINNER[frame % SPINNER.length]} </Text>
          <Text color="gray">
            Working… ({ms(Date.now() - turnStart.current)} · ↑{num(tokens.up)} tokens · esc to
            interrupt)
          </Text>
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
            {auto ? " ⏵⏵ auto-accept on" : " ⏵ step mode"} · /help · ↑{num(tokens.up)} ↓
            {num(tokens.down)} · ctx {num(tokens.ctx)}
          </Text>
        </Box>
      )}
    </Box>
  );
}
