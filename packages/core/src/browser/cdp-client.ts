import { debugLog } from "../debug.js";

export interface CDPClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, callback: (params: unknown) => void): void;
  off(event: string, callback: (params: unknown) => void): void;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// WebSocket.OPEN is 1 in every implementation; don't depend on the global enum
// being present at import time.
const WS_OPEN = 1;

export function createCDPClient(wsUrl: string): Promise<CDPClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    let closed = false;
    const pending = new Map<number, PendingRequest>();
    const listeners = new Map<string, Set<(params: unknown) => void>>();

    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            if (closed || ws.readyState !== WS_OPEN) {
              rej(new Error(`CDP send after close: ${method}`));
              return;
            }
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method} (id=${id})`));
            }, 30_000);
            pending.set(id, { resolve: res, reject: rej, timer });
            // ws.send throws synchronously (InvalidStateError) if the socket
            // slipped to CLOSING between the guard and here — clean up so we
            // don't leak a 30s timer + pending entry per stray send.
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (err) {
              clearTimeout(timer);
              pending.delete(id);
              rej(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },

        on(event, callback) {
          let set = listeners.get(event);
          if (!set) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(callback);
        },

        off(event, callback) {
          listeners.get(event)?.delete(callback);
        },

        close() {
          closed = true;
          for (const [, req] of pending) {
            clearTimeout(req.timer);
            req.reject(new Error("CDP client closed"));
          }
          pending.clear();
          ws.close();
        },
      });
    });

    ws.addEventListener("message", (event) => {
      // A malformed / truncated CDP frame must NEVER take down the process. This
      // handler runs on an EventTarget with no surrounding try/catch, and library
      // code installs no global uncaughtException net — so a raw JSON.parse throw
      // here once killed the whole daemon and every session it held.
      let msg: {
        id?: number;
        method?: string;
        error?: { message: string; code: number };
        result?: unknown;
        params?: unknown;
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch (err) {
        debugLog("cdp: dropped unparseable frame", err);
        return;
      }
      if (typeof msg.id === "number") {
        const req = pending.get(msg.id);
        if (req) {
          clearTimeout(req.timer);
          pending.delete(msg.id);
          if (msg.error) {
            req.reject(
              new Error(`CDP error: ${msg.error.message} (${msg.error.code})`),
            );
          } else {
            req.resolve(msg.result);
          }
        }
      } else if (typeof msg.method === "string") {
        const set = listeners.get(msg.method);
        if (set) {
          // Copy before iterating: a handler may off() itself mid-dispatch, and
          // a throwing handler must not abort delivery to the rest.
          for (const cb of [...set]) {
            try {
              cb(msg.params);
            } catch (err) {
              debugLog("cdp: event handler threw", msg.method, err);
            }
          }
        }
      }
    });

    ws.addEventListener("error", (e) => {
      if (!closed)
        debugLog("cdp: websocket error", String((e as ErrorEvent)?.message ?? e));
      reject(new Error(`CDP WebSocket error: ${(e as ErrorEvent)?.message ?? e}`));
    });

    ws.addEventListener("close", () => {
      closed = true;
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error("CDP WebSocket closed unexpectedly"));
      }
      pending.clear();
    });
  });
}
