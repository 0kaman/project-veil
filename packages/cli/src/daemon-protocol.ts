import { homedir } from "node:os";
import { join } from "node:path";

export const VEIL_DIR = join(homedir(), ".veil");
export const SOCKET_PATH = process.env.VEIL_SOCKET || join(VEIL_DIR, "daemon.sock");
export const PID_FILE = join(VEIL_DIR, "daemon.pid");
export const LOG_FILE = join(VEIL_DIR, "daemon.log");

export type RequestOp =
  | { op: "ping" }
  | { op: "openSession"; url: string }
  | { op: "listSessions" }
  | { op: "closeSession"; id: string }
  | { op: "getGraphCompact"; id: string }
  | { op: "getGraphJSON"; id: string }
  | { op: "getAllNodes"; id: string }
  | { op: "getNode"; id: string; nodeId: string }
  | { op: "interact"; id: string; nodeId: string; action: unknown }
  | { op: "navigate"; id: string; url: string }
  | { op: "auth"; id: string; loginUrl?: string; timeoutMs?: number };

export interface Request {
  rid: string;
  body: RequestOp;
}

export type Response =
  | { rid: string; ok: true; result: unknown }
  | { rid: string; ok: false; error: { code: string; message: string } };
