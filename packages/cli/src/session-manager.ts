import { Veil, type VeilPage, type AuthOptions, type AuthResult } from "@veil/core";

const MAX_SESSIONS = Number(process.env.VEIL_MAX_SESSIONS) || 10;
// Idle sessions keep a live CDP connection and a 5s AX-tree poll running
// forever; reap them so a long-lived daemon doesn't accrue zombie sessions and
// eventually refuse new ones at MAX_SESSIONS. 0 disables.
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
  authInProgress: boolean;
}

export class DaemonError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SessionManager {
  private veil: Veil;
  private sessions = new Map<string, Session>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.veil = new Veil();
    if (SESSION_TTL_MS > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), TTL_SWEEP_MS);
      this.sweepTimer.unref?.();
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (!s.authInProgress && now - s.lastActive > SESSION_TTL_MS) {
        try {
          s.page.close();
        } catch {
          /* already gone */
        }
        this.sessions.delete(id);
      }
    }
  }

  async createSession(url: string): Promise<SessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new DaemonError("MAX_SESSIONS", `Maximum ${MAX_SESSIONS} concurrent sessions reached`);
    }

    const id = crypto.randomUUID();
    // Build the graph BEFORE registering the session — if the first build throws
    // (nav timeout, crash mid-pipeline), we must not leave a broken half-session
    // in the map counting against MAX_SESSIONS forever.
    const page = await this.veil.open(url);
    try {
      await page.getGraph();
    } catch (err) {
      try {
        page.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    const createdAt = Date.now();
    this.sessions.set(id, { id, url, page, createdAt, lastActive: createdAt, authInProgress: false });
    return { id, url, createdAt };
  }

  getPage(id: string): VeilPage {
    const session = this.sessions.get(id);
    if (!session) throw new DaemonError("SESSION_NOT_FOUND", `Session "${id}" not found`);
    session.lastActive = Date.now();
    return session.page;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ id, url, createdAt }) => ({ id, url, createdAt }));
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new DaemonError("SESSION_NOT_FOUND", `Session "${id}" not found`);
    session.page.close();
    this.sessions.delete(id);
  }

  async navigateSession(id: string, url: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) throw new DaemonError("SESSION_NOT_FOUND", `Session "${id}" not found`);

    // Open the new page and confirm its first build BEFORE tearing down the old
    // one — if open()/getGraph() throws, the session keeps its working page
    // instead of being bricked with a reference to a closed CDP client.
    const oldPage = session.page;
    const newPage = await this.veil.open(url);
    try {
      await newPage.getGraph();
    } catch (err) {
      try {
        newPage.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    session.page = newPage;
    session.url = url;
    session.lastActive = Date.now();
    try {
      oldPage.close();
    } catch {
      /* ignore */
    }
    return { id: session.id, url: session.url, createdAt: session.createdAt };
  }

  async authSession(id: string, options?: AuthOptions): Promise<AuthResult> {
    const session = this.sessions.get(id);
    if (!session) throw new DaemonError("SESSION_NOT_FOUND", `Session "${id}" not found`);
    if (session.authInProgress) {
      throw new DaemonError("AUTH_IN_PROGRESS", "Authentication is already in progress for this session");
    }

    session.authInProgress = true;
    try {
      const result = await this.veil.auth(session.page, options);
      if (result.success) {
        const graph = await session.page.getGraph();
        session.url = graph.metadata.url;
      }
      return result;
    } finally {
      session.authInProgress = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const session of this.sessions.values()) {
      try {
        session.page.close();
      } catch {
        /* best effort */
      }
    }
    this.sessions.clear();
    await this.veil.close();
  }
}
