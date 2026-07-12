/**
 * MCP session store — a thin adapter over the shared core SessionPool.
 *
 * All the lifecycle hardening (build-before-register, idle TTL, best-effort
 * close, auth guard) lives once in @veil/core; here we only pick MCP-flavored
 * cosmetics: short ids ("s1", "s2") an agent can thread through tool calls, and
 * a SessionError type with agent-readable messages.
 */
import { SessionPool, type SessionInfo, type Veil } from "@veil/core";

export type { SessionInfo };

export class SessionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const HINTS: Record<string, string> = {
  SESSION_NOT_FOUND: " Open one with veil_open, or list them with veil_sessions.",
  MAX_SESSIONS: " Close one with veil_close first.",
};

export function createSessionStore(veil?: Veil): SessionPool {
  let counter = 0;
  return new SessionPool({
    veil,
    idFactory: () => `s${++counter}`,
    errorFactory: (code, message) =>
      new SessionError(code, message + (HINTS[code] ?? "")),
  });
}
