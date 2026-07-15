/**
 * Veil MCP client — hardwired.
 *
 * Spawns the REAL built server (packages/mcp/dist/server.js) over stdio rather
 * than importing registerVeilTools in-process. That is the point: this harness
 * must exercise the same path Claude Code / Claude Desktop take, protocol
 * serialization and all. An in-process shortcut would hide exactly the bugs
 * we're hunting.
 *
 * The server's stderr is piped and traced — with VEIL_DEBUG=1 that's where
 * Veil's intentionally-swallowed failures (dropped CDP frames, React-detection
 * fallbacks, enricher errors) become visible.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tracer } from "./trace.js";
import { approxTokens } from "./graph-stats.js";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolOutcome {
  text: string;
  ok: boolean;
  ms: number;
}

export class VeilMcp {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: ToolSchema[] = [];

  constructor(
    private readonly serverPath: string,
    private readonly tracer: Tracer,
  ) {}

  async connect(): Promise<ToolSchema[]> {
    const t0 = Date.now();

    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.serverPath],
      // Inherit VEIL_DEBUG etc. from the loaded .env.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "veil-playground", version: "0.1.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);

    // Must be attached AFTER connect() — the transport spawns there.
    this.transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.tracer.emit({ kind: "mcp.stderr", line: line.trimEnd() });
      }
    });

    const listed = await this.client.listTools();
    this.tools = listed.tools.map((t) => {
      // Mistral rejects the draft-07 $schema key inside function parameters.
      const { $schema, ...parameters } = (t.inputSchema ?? {}) as Record<string, unknown>;
      void $schema;
      return {
        name: t.name,
        description: t.description ?? "",
        parameters: parameters as Record<string, unknown>,
      };
    });

    this.tracer.emit({
      kind: "mcp.connect",
      ms: Date.now() - t0,
      tools: this.tools.map((t) => t.name),
    });

    return this.tools;
  }

  toolSchemas(): ToolSchema[] {
    return this.tools;
  }

  /**
   * Call a tool. Never throws: a transport failure is reported as a failed
   * outcome so the agent loop can feed the error back to the model and let it
   * recover — the same contract Veil's own `guard()` gives real MCP clients.
   */
  async call(step: number, id: string, name: string, args: unknown): Promise<ToolOutcome> {
    this.tracer.emit({ kind: "tool.call", step, id, name, args });
    const t0 = Date.now();

    let text: string;
    let ok: boolean;
    try {
      const res = await this.client!.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      const content = (res.content ?? []) as { type: string; text?: string }[];
      text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      ok = res.isError !== true;
    } catch (err) {
      text = `[TRANSPORT_ERROR] ${err instanceof Error ? err.message : String(err)}`;
      ok = false;
    }

    const ms = Date.now() - t0;
    this.tracer.emit({
      kind: "tool.result",
      step,
      id,
      name,
      ms,
      ok,
      chars: text.length,
      approxTokens: approxTokens(text),
      text,
    });

    return { text, ok, ms };
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* shutting down anyway */
    }
  }
}
