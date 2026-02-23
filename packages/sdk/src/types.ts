/** Options for Veil.open() — forward-compat stub */
export interface OpenOptions {
  /** Navigation timeout in milliseconds */
  timeout?: number;
}

/** Top-level Veil configuration — forward-compat stub */
export interface VeilOptions {
  /** Path to Chromium binary (auto-detected if omitted) */
  chromiumPath?: string;
  /** Run browser in headful mode */
  headless?: boolean;
}
