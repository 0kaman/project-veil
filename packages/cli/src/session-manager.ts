import { Veil, type VeilPage, type AuthOptions, type AuthResult } from "@veil/core";

const MAX_SESSIONS = Number(process.env.VEIL_MAX_SESSIONS) || 10;

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

  constructor() {
    this.veil = new Veil();
  }

  async createSession(url: string): Promise<SessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new DaemonError("MAX_SESSIONS", `Maximum ${MAX_SESSIONS} concurrent sessions reached`);
    }

    const id = crypto.randomUUID();
    const page = await this.veil.open(url);
    const createdAt = Date.now();

    this.sessions.set(id, { id, url, page, createdAt, authInProgress: false });

    await page.getGraph();

    return { id, url, createdAt };
  }

  getPage(id: string): VeilPage {
    const session = this.sessions.get(id);
    if (!session) throw new DaemonError("SESSION_NOT_FOUND", `Session "${id}" not found`);
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

    session.page.close();
    const newPage = await this.veil.open(url);
    session.page = newPage;
    session.url = url;
    await newPage.getGraph();

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
    for (const session of this.sessions.values()) {
      session.page.close();
    }
    this.sessions.clear();
    await this.veil.close();
  }
}
