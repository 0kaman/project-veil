import { launchBrowser } from "./launcher.js";
import { connectToPage } from "./page.js";
import type { CDPClient } from "./cdp-client.js";

export interface AuthOptions {
  loginUrl?: string;           // defaults to session's current URL
  timeoutMs?: number;          // default: 120_000 (2 min)
  onReady?: (info: { browserPid: number; url: string }) => void;
  manualSignal?: Promise<void>; // resolves when user signals done
}

export interface AuthResult {
  success: boolean;
  cookieCount: number;
  finalUrl: string;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  sameParty?: boolean;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: string;
}

const LOGIN_PATH_PATTERNS = [
  /\/log[-_]?in/i,
  /\/sign[-_]?in/i,
  /\/auth/i,
  /\/sso/i,
  /\/oauth/i,
  /\/cas\/login/i,
  /\/saml/i,
];

function isLoginPath(pathname: string): boolean {
  return LOGIN_PATH_PATTERNS.some((p) => p.test(pathname));
}

function isOAuthDomain(url: string, originalDomain: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === originalDomain) return false;
    // Common OAuth providers — don't declare login complete while on these
    const oauthDomains = [
      "accounts.google.com",
      "github.com",
      "login.microsoftonline.com",
      "appleid.apple.com",
      "auth0.com",
      "okta.com",
      "login.live.com",
    ];
    return oauthDomains.some(
      (d) => u.hostname === d || u.hostname.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

export async function extractCookies(cdp: CDPClient): Promise<CdpCookie[]> {
  const result = (await cdp.send("Network.getAllCookies")) as {
    cookies: CdpCookie[];
  };
  return result.cookies;
}

export async function injectCookies(
  cdp: CDPClient,
  cookies: CdpCookie[],
): Promise<void> {
  await cdp.send("Network.clearBrowserCookies");
  for (const cookie of cookies) {
    await cdp.send("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires > 0 ? cookie.expires : undefined,
    });
  }
}

export async function performAuthFlow(
  headlessCdp: CDPClient,
  currentUrl: string,
  options?: AuthOptions,
): Promise<AuthResult> {
  const loginUrl = options?.loginUrl ?? currentUrl;
  const timeoutMs = options?.timeoutMs ?? 120_000;
  let headedBrowser: { close(): Promise<void>; port: number } | null = null;

  try {
    // 1. Launch headed browser
    headedBrowser = await launchBrowser({
      headless: false,
      startUrl: loginUrl,
    });

    // 2. Connect to headed page
    const headedPage = await connectToPage(headedBrowser.port);
    const headedCdp = headedPage.cdp;

    // 3. Enable required domains
    await headedCdp.send("Network.enable");
    await headedCdp.send("Page.enable");

    // 4. Navigate to login URL
    await headedPage.navigate(loginUrl);

    // 5. Notify caller browser is ready
    options?.onReady?.({
      browserPid: 0, // not easily accessible after refactor, but non-critical
      url: loginUrl,
    });

    // 6. Wait for login completion
    const originalDomain = new URL(loginUrl).hostname;
    const finalUrl = await waitForLoginCompletion(
      headedCdp,
      originalDomain,
      timeoutMs,
      options?.manualSignal,
    );

    // 7. Extract cookies from headed browser
    const cookies = await extractCookies(headedCdp);

    // 8. Close headed browser
    headedPage.close();
    await headedBrowser.close();
    headedBrowser = null;

    // 9. Inject cookies into headless session
    await injectCookies(headlessCdp, cookies);

    return {
      success: true,
      cookieCount: cookies.length,
      finalUrl,
    };
  } catch (err) {
    // Timeout or crash — still try to extract cookies for partial result
    const finalUrl = loginUrl;
    let cookieCount = 0;

    try {
      if (headedBrowser) {
        const headedPage = await connectToPage(headedBrowser.port);
        const cookies = await extractCookies(headedPage.cdp);
        if (cookies.length > 0) {
          await injectCookies(headlessCdp, cookies);
          cookieCount = cookies.length;
        }
        headedPage.close();
      }
    } catch {
      // Can't recover — that's fine
    }

    return {
      success: false,
      cookieCount,
      finalUrl,
    };
  } finally {
    if (headedBrowser) {
      await headedBrowser.close().catch(() => {});
    }
  }
}

function waitForLoginCompletion(
  headedCdp: CDPClient,
  originalDomain: string,
  timeoutMs: number,
  manualSignal?: Promise<void>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let currentUrl = "";
    let stabilizationTimer: ReturnType<typeof setTimeout> | null = null;
    const STABILIZATION_MS = 3_000;

    const cleanup = () => {
      headedCdp.off("Page.frameNavigated", onNavigated);
      if (stabilizationTimer) clearTimeout(stabilizationTimer);
      clearTimeout(timeoutTimer);
    };

    const done = (url: string) => {
      cleanup();
      resolve(url);
    };

    const onNavigated = (params: unknown) => {
      const p = params as {
        frame: { url: string; parentId?: string };
      };
      // Only track top-level frame navigations
      if (p.frame.parentId) return;

      currentUrl = p.frame.url;

      // Reset stabilization timer on every navigation
      if (stabilizationTimer) {
        clearTimeout(stabilizationTimer);
        stabilizationTimer = null;
      }

      try {
        const u = new URL(currentUrl);

        // Still on an OAuth provider — wait
        if (isOAuthDomain(currentUrl, originalDomain)) return;

        // Back on original domain, and NOT on a login path → start stabilization
        if (
          u.hostname === originalDomain &&
          !isLoginPath(u.pathname)
        ) {
          stabilizationTimer = setTimeout(() => {
            done(currentUrl);
          }, STABILIZATION_MS);
        }
      } catch {
        // Invalid URL — ignore
      }
    };

    headedCdp.on("Page.frameNavigated", onNavigated);

    // Timeout
    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`Auth timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Manual signal (user presses Enter in CLI)
    if (manualSignal) {
      manualSignal.then(() => {
        done(currentUrl || originalDomain);
      });
    }
  });
}
