import { getBaseUrl } from "./daemon.js";
import type { InteractAction, BehaviorNode } from "@veil/sdk";

export interface SessionInfo {
  id: string;
  url: string;
  createdAt: number;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

export class VeilClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = getBaseUrl();
  }

  private async request(path: string, opts?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, opts);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as ErrorEnvelope;
        if (body.error?.message) message = body.error.message;
      } catch {}
      throw new Error(message);
    }
    return res;
  }

  // --- Sessions ---

  async openSession(url: string): Promise<SessionInfo> {
    const res = await this.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return res.json() as Promise<SessionInfo>;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.request("/api/sessions");
    return res.json() as Promise<SessionInfo[]>;
  }

  async closeSession(id: string): Promise<void> {
    await this.request(`/api/sessions/${id}`, { method: "DELETE" });
  }

  async closeAllSessions(): Promise<void> {
    const sessions = await this.listSessions();
    await Promise.all(sessions.map((s) => this.closeSession(s.id)));
  }

  // --- Graph ---

  async getGraphCompact(id: string): Promise<string> {
    const res = await this.request(`/api/sessions/${id}/graph/compact`);
    return res.text();
  }

  async getGraphJSON(id: string): Promise<object> {
    const res = await this.request(`/api/sessions/${id}/graph`);
    return res.json() as Promise<object>;
  }

  async getAllNodes(id: string): Promise<BehaviorNode[]> {
    const res = await this.request(`/api/sessions/${id}/graph/nodes`);
    return res.json() as Promise<BehaviorNode[]>;
  }

  async getNode(id: string, nodeId: string): Promise<BehaviorNode> {
    const res = await this.request(`/api/sessions/${id}/graph/nodes/${nodeId}`);
    return res.json() as Promise<BehaviorNode>;
  }

  // --- Interact ---

  async interact(id: string, nodeId: string, action: InteractAction): Promise<string> {
    await this.request(`/api/sessions/${id}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, action }),
    });
    return this.getGraphCompact(id);
  }

  async navigate(id: string, url: string): Promise<string> {
    await this.request(`/api/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return this.getGraphCompact(id);
  }
}

export function createClient(): VeilClient {
  return new VeilClient();
}
