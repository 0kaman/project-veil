/**
 * CLI daemon session manager — a thin adapter over the shared core SessionPool.
 *
 * The lifecycle hardening (build-before-register, navigate open-before-close,
 * idle TTL, auth guard, best-effort close) lives once in @veil/core. Here we keep
 * only the CLI's cosmetics — UUID session ids and a DaemonError type — and the
 * method names daemon-server.ts already calls.
 */
import { SessionPool, type SessionInfo, type AuthOptions, type AuthResult, type VeilPage } from "@veil/core";
import { randomUUID } from "node:crypto";

export type { SessionInfo };

export class DaemonError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SessionManager {
  private pool = new SessionPool({
    idFactory: () => randomUUID(),
    errorFactory: (code, message) => new DaemonError(code, message),
  });

  createSession(url: string): Promise<SessionInfo> {
    return this.pool.open(url);
  }

  getPage(id: string): VeilPage {
    return this.pool.page(id);
  }

  listSessions(): SessionInfo[] {
    return this.pool.list();
  }

  closeSession(id: string): void {
    this.pool.close(id);
  }

  navigateSession(id: string, url: string): Promise<SessionInfo> {
    return this.pool.navigate(id, url);
  }

  authSession(id: string, options?: AuthOptions): Promise<AuthResult> {
    return this.pool.auth(id, options);
  }

  shutdown(): Promise<void> {
    return this.pool.shutdown();
  }
}
