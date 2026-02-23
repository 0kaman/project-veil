import type { CDPClient } from "./cdp-client.js";

export type MutationCallback = (reason: "mutation" | "navigation" | "poll") => void;

export class MutationWatcher {
  private cdp: CDPClient;
  private callback: MutationCallback;
  private debounceMs: number;
  private pollIntervalMs: number;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private onChildInserted: ((params: unknown) => void) | null = null;
  private onChildRemoved: ((params: unknown) => void) | null = null;
  private onAttributeModified: ((params: unknown) => void) | null = null;
  private onDocumentUpdated: ((params: unknown) => void) | null = null;
  private onSpaNavigation: ((params: unknown) => void) | null = null;

  constructor(
    cdp: CDPClient,
    callback: MutationCallback,
    debounceMs = 150,
    pollIntervalMs = 5_000,
  ) {
    this.cdp = cdp;
    this.callback = callback;
    this.debounceMs = debounceMs;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const debouncedMutation = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.running) this.callback("mutation");
      }, this.debounceMs);
    };

    this.onChildInserted = () => debouncedMutation();
    this.onChildRemoved = () => debouncedMutation();
    this.onAttributeModified = () => debouncedMutation();

    // Full-page navigation — force full rebuild, no debounce
    this.onDocumentUpdated = () => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      if (this.running) this.callback("navigation");
    };

    // SPA route changes
    this.onSpaNavigation = () => debouncedMutation();

    this.cdp.on("DOM.childNodeInserted", this.onChildInserted);
    this.cdp.on("DOM.childNodeRemoved", this.onChildRemoved);
    this.cdp.on("DOM.attributeModified", this.onAttributeModified);
    this.cdp.on("DOM.documentUpdated", this.onDocumentUpdated);
    this.cdp.on("Page.navigatedWithinDocument", this.onSpaNavigation);

    // Consistency poll — catches shadow DOM changes CDP misses
    this.pollTimer = setInterval(() => {
      if (this.running) this.callback("poll");
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.onChildInserted) {
      this.cdp.off("DOM.childNodeInserted", this.onChildInserted);
      this.onChildInserted = null;
    }
    if (this.onChildRemoved) {
      this.cdp.off("DOM.childNodeRemoved", this.onChildRemoved);
      this.onChildRemoved = null;
    }
    if (this.onAttributeModified) {
      this.cdp.off("DOM.attributeModified", this.onAttributeModified);
      this.onAttributeModified = null;
    }
    if (this.onDocumentUpdated) {
      this.cdp.off("DOM.documentUpdated", this.onDocumentUpdated);
      this.onDocumentUpdated = null;
    }
    if (this.onSpaNavigation) {
      this.cdp.off("Page.navigatedWithinDocument", this.onSpaNavigation);
      this.onSpaNavigation = null;
    }
  }
}
