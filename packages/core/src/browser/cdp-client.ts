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

export function createCDPClient(wsUrl: string): Promise<CDPClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<number, PendingRequest>();
    const listeners = new Map<string, Set<(params: unknown) => void>>();

    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method} (id=${id})`));
            }, 30_000);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
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
      const msg = JSON.parse(String(event.data));
      if ("id" in msg) {
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
      } else if ("method" in msg) {
        const set = listeners.get(msg.method);
        if (set) {
          for (const cb of set) cb(msg.params);
        }
      }
    });

    ws.addEventListener("error", (e) => {
      reject(new Error(`CDP WebSocket error: ${e}`));
    });

    ws.addEventListener("close", () => {
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error("CDP WebSocket closed unexpectedly"));
      }
      pending.clear();
    });
  });
}
