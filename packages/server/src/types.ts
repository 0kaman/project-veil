import type { InteractAction } from "@veil/sdk";

// --- Server config ---

export interface ServerConfig {
  port: number;
  host: string;
  maxSessions: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 3100,
  host: "127.0.0.1",
  maxSessions: 10,
};

// --- REST request/response types ---

export interface CreateSessionRequest {
  url: string;
}

export interface InteractRequest {
  nodeId: string;
  action: InteractAction;
}

export interface NavigateRequest {
  url: string;
}

export interface SessionInfo {
  id: string;
  url: string;
  createdAt: number;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    status: number;
  };
}

// --- WebSocket protocol ---

export type WsServerMessage =
  | { type: "snapshot"; graph: Record<string, unknown>; version: number }
  | { type: "diff"; diff: { added: string[]; removed: string[]; modified: string[] }; graph: Record<string, unknown>; version: number }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "pong" }
  | { type: "closed"; reason: string };

export type WsClientMessage =
  | { type: "ping" }
  | { type: "resync" };
