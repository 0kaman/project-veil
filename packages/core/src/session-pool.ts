/**
 * SessionPool — the hardened, reusable session lifecycle.
 *
 * Both the MCP server and the CLI daemon keep a shared Chrome alive and hand out
 * per-tab sessions to callers. They hit the exact same lifecycle hazards:
 * build-before-register (no dangling half-sessions), navigate open-before-close
 * (no bricked session on failure), idle-TTL reaping, best-effort close, and a
 * per-session auth guard. This class owns all of it once, so a fix lands in one
 * place instead of drifting between two copies.
 *
 * Callers differ only in cosmetics — id format and error type — so those are
 * injected via options.
 */
import { Veil, type VeilPage, type AuthOptions, type AuthResult } from "./index.js";

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
  authInProgress: boolean;
}

export interface SessionPoolOptions {
  /** Injectable for tests (a fake Veil with no real Chrome). */
  veil?: Veil;
  maxSessions?: number;
  /** Idle-reap time in ms; 0 disables the sweep. */
  ttlMs?: number;
  /** How to mint a session id (UUID for the CLI, "s1"/"s2" for MCP). */
  idFactory?: () => string;
  /** How to raise a not-found / limit error (DaemonError vs SessionError). */
  errorFactory?: (code: string, message: string) => Error;
}

const DEFAULT_MAX = Number(process.env.VEIL_MAX_SESSIONS) || 10;
const DEFAULT_TTL = Number(process.env.VEIL_SESSION_TTL_MS) || 30 * 60_000;
const TTL_SWEEP_MS = 60_000;

export class SessionPool {
  private veil: Veil;
  private sessions = new Map<string, Session>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private maxSessions: number;
  private ttlMs: number;
  private mintId: () => string;
  private fail: (code: string, message: string) => Error;
  private uuidCounter = 0;

  constructor(options: SessionPoolOptions = {}) {
    this.veil = options.veil ?? new Veil();
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL;
    this.mintId = options.idFactory ?? (() => `s${++this.uuidCounter}`);
    this.fail =
      options.errorFactory ??
      ((code, message) => Object.assign(new Error(message), { code }));
    if (this.ttlMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), TTL_SWEEP_MS);
      this.sweepTimer.unref?.();
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (!s.authInProgress && now - s.lastActive > this.ttlMs) {
        closeQuietly(s.page);
        this.sessions.delete(id);
      }
    }
  }

  private require(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw this.fail("SESSION_NOT_FOUND", `No open session "${id}".`);
    s.lastActive = Date.now();
    return s;
  }

  async open(url: string): Promise<SessionInfo> {
    if (this.sessions.size >= this.maxSessions) {
      throw this.fail(
        "MAX_SESSIONS",
        `Maximum ${this.maxSessions} concurrent sessions reached.`,
      );
    }
    // Build the graph BEFORE registering — if the first build throws, we must not
    // leave a broken half-session counting against maxSessions forever.
    const page = await this.veil.open(url);
    try {
      await page.getGraph();
    } catch (err) {
      closeQuietly(page);
      throw err;
    }
    const id = this.mintId();
    const now = Date.now();
    this.sessions.set(id, { id, url, page, createdAt: now, lastActive: now, authInProgress: false });
    return { id, url, createdAt: now };
  }

  page(id: string): VeilPage {
    return this.require(id).page;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(({ id, url, createdAt }) => ({ id, url, createdAt }));
  }

  close(id: string): void {
    const s = this.require(id);
    closeQuietly(s.page);
    this.sessions.delete(id);
  }

  async navigate(id: string, url: string): Promise<SessionInfo> {
    const s = this.require(id);
    // Open + confirm the new page's first build BEFORE tearing down the old one,
    // so a failed navigation keeps the working page instead of bricking it.
    const oldPage = s.page;
    const newPage = await this.veil.open(url);
    try {
      await newPage.getGraph();
    } catch (err) {
      closeQuietly(newPage);
      throw err;
    }
    s.page = newPage;
    s.url = url;
    s.lastActive = Date.now();
    closeQuietly(oldPage);
    return { id: s.id, url: s.url, createdAt: s.createdAt };
  }

  async auth(id: string, options?: AuthOptions): Promise<AuthResult> {
    const s = this.require(id);
    if (s.authInProgress) {
      throw this.fail("AUTH_IN_PROGRESS", "Authentication is already in progress for this session.");
    }
    s.authInProgress = true;
    try {
      const result = await this.veil.auth(s.page, options);
      if (result.success) {
        s.url = (await s.page.getGraph()).metadata.url;
      }
      return result;
    } finally {
      s.authInProgress = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.sessions.values()) closeQuietly(s.page);
    this.sessions.clear();
    await this.veil.close();
  }
}

function closeQuietly(page: VeilPage): void {
  try {
    page.close();
  } catch {
    /* best effort — already gone */
  }
}
