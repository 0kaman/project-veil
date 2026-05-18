import type { CDPClient } from "../../browser/cdp-client.js";

/**
 * Type-erased CDP method handler. Returns the response payload or throws.
 * Receiver may be `undefined` for `Page.enable` etc. that take no params.
 */
export type CDPMethodHandler = (
  params?: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface ScriptedEvent {
  event: string;
  params?: unknown;
  /** Milliseconds after the previous event (or after `playback()` call). */
  delayMs?: number;
}

/**
 * In-process CDPClient stand-in.
 *
 * Test-only. Scripts responses for `send(method, params)`; emits scripted
 * events on `playback()`; tracks every attached listener so tests can assert
 * about leaks.
 */
export class FakeCDPClient implements CDPClient {
  private handlers = new Map<string, CDPMethodHandler>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;
  /** History of every send() call, in order. */
  readonly sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** History of every emitted event. */
  readonly emits: Array<{ event: string; params: unknown }> = [];

  /** Register a handler for a CDP method. Replaces any existing handler. */
  on_send(method: string, handler: CDPMethodHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Convenience: respond to a method with a static payload. */
  respond(method: string, payload: unknown): this {
    return this.on_send(method, () => payload);
  }

  /** Make `send(method)` throw an error. */
  throwOn(method: string, message: string): this {
    return this.on_send(method, () => {
      throw new Error(message);
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error("CDP client closed");
    this.sends.push({ method, params });

    const handler = this.handlers.get(method);
    if (!handler) {
      // Mimic real CDP: silently return {} for methods like Page.enable that
      // we don't care about, but record the call. Tests can assert that
      // unexpected methods weren't called by inspecting `sends`.
      return {};
    }
    return await handler(params);
  }

  on(event: string, callback: (params: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: string, callback: (params: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.handlers.clear();
  }

  /** Synchronously emit one event. Tests use this for tight timing control. */
  emit(event: string, params: unknown = {}): void {
    this.emits.push({ event, params });
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(params);
  }

  /** Play a scripted sequence of events. Returns when the last fires. */
  async playback(events: ScriptedEvent[]): Promise<void> {
    for (const e of events) {
      if (e.delayMs && e.delayMs > 0) {
        await new Promise((r) => setTimeout(r, e.delayMs));
      }
      this.emit(e.event, e.params);
    }
  }

  /** Count of currently-attached listeners for `event`. 0 if none. */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Total listeners attached across all events — useful for leak assertions. */
  totalListenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}
