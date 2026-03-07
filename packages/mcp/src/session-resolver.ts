import type { SessionManager } from "@veil/server";

export function resolveSessionId(
  manager: SessionManager,
  rawId: string,
): string {
  if (rawId.length === 36) {
    // Full UUID — validate it exists
    manager.getPage(rawId); // throws SESSION_NOT_FOUND if invalid
    return rawId;
  }

  const sessions = manager.listSessions();
  const matches = sessions.filter((s) => s.id.startsWith(rawId));

  if (matches.length === 0) {
    throw new Error(`No session found matching "${rawId}"`);
  }
  if (matches.length > 1) {
    const ids = matches.map((s) => s.id).join(", ");
    throw new Error(`Ambiguous session ID "${rawId}". Matches: ${ids}`);
  }

  return matches[0].id;
}
