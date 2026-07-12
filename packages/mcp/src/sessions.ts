/**
 * In-process session store for the MCP server.
 *
 * One shared Chrome (via a single Veil instance); each veil_open gets its own
 * tab. Lifecycle mirrors the daemon's hardened SessionManager: build-before-
 * register (no dangling half-sessions), idle-TTL reaping (an MCP client may
 * hold a connection for a long time), and best-effort close everywhere.
 */
import { Veil, type VeilPage, type AuthOptions, type AuthResult } from "@veil/core";

const MAX_SESSIONS = Number(process.env.VEIL_MAX_SESSIONS) || 10;
const SESSION_TTL_MS = Number(process.env.VEIL_SESSION_TTL_MS) || 30 * 60_000;
const TTL_SWEEP_MS = 60_000;

export interface SessionInfo {
  id: string;
  url: string;
  createdAt: number;
}

interface Session {
  id: string;
  url: string;
  page: VeilPage;
  createdAt: number;
  lastActive: number;
}

export class SessionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SessionStore {
  private veil: Veil;
  private sessions = new Map<string, Session>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idCounter = 0;

  constructor(veil?: Veil) {
    this.veil = veil ?? new Veil();
    if (SESSION_TTL_MS > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), TTL_SWEEP_MS);
      this.sweepTimer.unref?.();
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActive > SESSION_TTL_MS) {
        try {
          s.page.close();
        } catch {
          /* already gone */
        }
        this.sessions.delete(id);
      }
    }
  }

  private nextId(): string {
    // Short, human-friendly ids ("s1", "s2") — an LLM agent threads these
    // through tool calls, so brevity beats UUIDs.
    return `s${++this.idCounter}`;
  }

  async open(url: string): Promise<SessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new SessionError(
        "MAX_SESSIONS",
        `Maximum ${MAX_SESSIONS} concurrent sessions reached — close one with veil_close first.`,
      );
    }
    const page = await this.veil.open(url);
    try {
      await page.getGraph(); // confirm the first build before registering
    } catch (err) {
      try {
        page.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    const id = this.nextId();
    const now = Date.now();
    this.sessions.set(id, { id, url, page, createdAt: now, lastActive: now });
    return { id, url, createdAt: now };
  }

  page(id: string): VeilPage {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionError(
        "SESSION_NOT_FOUND",
        `No open session "${id}". Open one with veil_open, or list them with veil_sessions.`,
      );
    }
    s.lastActive = Date.now();
    return s.page;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(({ id, url, createdAt }) => ({
      id,
      url,
      createdAt,
    }));
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionError("SESSION_NOT_FOUND", `No open session "${id}".`);
    }
    try {
      s.page.close();
    } catch {
      /* best effort */
    }
    this.sessions.delete(id);
  }

  async auth(id: string, options?: AuthOptions): Promise<AuthResult> {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionError("SESSION_NOT_FOUND", `No open session "${id}".`);
    }
    const result = await this.veil.auth(s.page, options);
    if (result.success) {
      const graph = await s.page.getGraph();
      s.url = graph.metadata.url;
    }
    s.lastActive = Date.now();
    return result;
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.sessions.values()) {
      try {
        s.page.close();
      } catch {
        /* best effort */
      }
    }
    this.sessions.clear();
    await this.veil.close();
  }
}
