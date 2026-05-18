import { connect, type Socket } from "node:net";
import type { InteractAction, BehaviorNode } from "@veil/core";
import { SOCKET_PATH, type Request, type RequestOp, type Response } from "./daemon-protocol.js";

export interface SessionInfo {
  id: string;
  url: string;
  createdAt: number;
}

export class VeilClient {
  private socket: Socket | null = null;
  private buf = "";
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;

    return new Promise<Socket>((resolveConn, rejectConn) => {
      const sock = connect(SOCKET_PATH);
      const onError = (err: Error) => {
        sock.off("connect", onConnect);
        rejectConn(err);
      };
      const onConnect = () => {
        sock.off("error", onError);
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("close", () => this.onClose());
        sock.on("error", () => this.onClose());
        sock.unref();
        this.socket = sock;
        resolveConn(sock);
      };
      sock.once("error", onError);
      sock.once("connect", onConnect);
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;

      let res: Response;
      try {
        res = JSON.parse(line) as Response;
      } catch {
        continue;
      }

      const handler = this.pending.get(res.rid);
      if (!handler) continue;
      this.pending.delete(res.rid);

      if (res.ok) {
        handler.resolve(res.result);
      } else {
        handler.reject(new Error(res.error.message));
      }
    }
  }

  private onClose(): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error("Daemon connection closed"));
    }
    this.pending.clear();
    this.socket = null;
    this.buf = "";
  }

  private async send<T>(body: RequestOp, timeoutMs = 60_000): Promise<T> {
    const sock = await this.connect();
    const rid = String(++this.nextId);
    const req: Request = { rid, body };

    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        rejectCall(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(rid, {
        resolve: (v) => { clearTimeout(timer); resolveCall(v as T); },
        reject: (e) => { clearTimeout(timer); rejectCall(e); },
      });

      sock.write(JSON.stringify(req) + "\n");
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  // --- Sessions ---

  async openSession(url: string): Promise<SessionInfo> {
    return this.send<SessionInfo>({ op: "openSession", url });
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.send<SessionInfo[]>({ op: "listSessions" });
  }

  async closeSession(id: string): Promise<void> {
    await this.send({ op: "closeSession", id });
  }

  async closeAllSessions(): Promise<void> {
    const sessions = await this.listSessions();
    await Promise.all(sessions.map((s) => this.closeSession(s.id)));
  }

  // --- Graph ---

  async getGraphCompact(id: string): Promise<string> {
    return this.send<string>({ op: "getGraphCompact", id });
  }

  async getGraphJSON(id: string): Promise<object> {
    return this.send<object>({ op: "getGraphJSON", id });
  }

  async getAllNodes(id: string): Promise<BehaviorNode[]> {
    return this.send<BehaviorNode[]>({ op: "getAllNodes", id });
  }

  async getNode(id: string, nodeId: string): Promise<BehaviorNode> {
    return this.send<BehaviorNode>({ op: "getNode", id, nodeId });
  }

  // --- Interact ---

  async interact(id: string, nodeId: string, action: InteractAction): Promise<string> {
    return this.send<string>({ op: "interact", id, nodeId, action });
  }

  // --- Auth ---

  async auth(
    id: string,
    options?: { loginUrl?: string; timeoutMs?: number },
  ): Promise<{ success: boolean; cookieCount: number; finalUrl: string }> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    return this.send(
      { op: "auth", id, loginUrl: options?.loginUrl, timeoutMs },
      timeoutMs + 10_000,
    );
  }

  // --- Navigate ---

  async navigate(id: string, url: string): Promise<string> {
    return this.send<string>({ op: "navigate", id, url });
  }
}

export function createClient(): VeilClient {
  return new VeilClient();
}
