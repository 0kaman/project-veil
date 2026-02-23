import { Veil, type VeilPage, type GraphChangeCallback } from "@veil/sdk";
import { ServerError } from "./errors.js";
import type { SessionInfo } from "./types.js";

interface Session {
  id: string;
  url: string;
  page: VeilPage;
  createdAt: number;
  /** Listeners registered through the manager — re-wired on navigate */
  changeListeners: Map<GraphChangeCallback, () => void>;
}

export class SessionManager {
  private veil: Veil;
  private sessions = new Map<string, Session>();
  private maxSessions: number;

  constructor(maxSessions = 10) {
    this.veil = new Veil();
    this.maxSessions = maxSessions;
  }

  async createSession(url: string): Promise<SessionInfo> {
    if (this.sessions.size >= this.maxSessions) {
      throw new ServerError(429, "MAX_SESSIONS", `Maximum ${this.maxSessions} concurrent sessions reached`);
    }

    const id = crypto.randomUUID();
    const page = await this.veil.open(url);
    const createdAt = Date.now();

    this.sessions.set(id, { id, url, page, createdAt, changeListeners: new Map() });

    // Eagerly build graph so it's ready for queries
    await page.getGraph();

    return { id, url, createdAt };
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getPage(id: string): VeilPage {
    const session = this.sessions.get(id);
    if (!session) throw new ServerError(404, "SESSION_NOT_FOUND", `Session "${id}" not found`);
    return session.page;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ id, url, createdAt }) => ({ id, url, createdAt }));
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new ServerError(404, "SESSION_NOT_FOUND", `Session "${id}" not found`);

    // Unsubscribe all change listeners
    for (const unsub of session.changeListeners.values()) {
      unsub();
    }
    session.changeListeners.clear();

    session.page.close();
    this.sessions.delete(id);
  }

  async navigateSession(id: string, url: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) throw new ServerError(404, "SESSION_NOT_FOUND", `Session "${id}" not found`);

    // Collect existing listeners before closing old page
    const listeners = Array.from(session.changeListeners.keys());

    // Unsubscribe old listeners and close old page
    for (const unsub of session.changeListeners.values()) {
      unsub();
    }
    session.changeListeners.clear();
    session.page.close();

    // Open new page
    const newPage = await this.veil.open(url);
    session.page = newPage;
    session.url = url;

    // Eagerly build graph
    await newPage.getGraph();

    // Re-wire all listeners on the new page
    for (const cb of listeners) {
      const unsub = newPage.onGraphChange(cb);
      session.changeListeners.set(cb, unsub);
    }

    return { id: session.id, url: session.url, createdAt: session.createdAt };
  }

  /**
   * Register a graph change listener that survives navigateSession() calls.
   * Returns an unsubscribe function.
   */
  addChangeListener(id: string, callback: GraphChangeCallback): () => void {
    const session = this.sessions.get(id);
    if (!session) throw new ServerError(404, "SESSION_NOT_FOUND", `Session "${id}" not found`);

    const unsub = session.page.onGraphChange(callback);
    session.changeListeners.set(callback, unsub);

    return () => {
      const current = this.sessions.get(id);
      if (current) {
        const currentUnsub = current.changeListeners.get(callback);
        if (currentUnsub) currentUnsub();
        current.changeListeners.delete(callback);
      }
    };
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const unsub of session.changeListeners.values()) {
        unsub();
      }
      session.page.close();
    }
    this.sessions.clear();
    await this.veil.close();
  }
}
