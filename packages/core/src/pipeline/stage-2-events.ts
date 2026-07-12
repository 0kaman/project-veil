import type { CDPClient } from "../browser/cdp-client.js";
import type { BehaviorGraph, BehaviorNode, EventBinding } from "../graph/model.js";
import { debugLog } from "../debug.js";
import {
  queryInjectedRegistry,
  type InjectedRegistryData,
} from "../browser/instrumentation.js";
import {
  isFrameworkFrame,
  parseStackFrames,
  extractPath,
} from "./utils.js";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "select",
  "listbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "searchbox",
  "option",
  "treeitem",
]);

interface CDPEventListener {
  type: string;
  handler: { objectId?: string };
  scriptId?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface ReactHandlerInfo {
  eventType: string;
  handlerString: string;
  handlerKey: string;
}

interface CDPInternalProperty {
  name: string;
  value?: {
    value?: {
      scriptId?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
  };
}

export async function collectScriptUrls(cdp: CDPClient): Promise<Map<string, string>> {
  const scriptUrls = new Map<string, string>();
  const onScriptParsed = (params: unknown) => {
    const p = params as { scriptId: string; url?: string };
    if (p.url) scriptUrls.set(p.scriptId, p.url);
  };
  cdp.on("Debugger.scriptParsed", onScriptParsed);
  // Disable and re-enable to get replay of all parsed scripts
  await cdp.send("Debugger.disable");
  await cdp.send("Debugger.enable");
  // Brief wait for scriptParsed events to arrive
  await new Promise((r) => setTimeout(r, 50));
  cdp.off("Debugger.scriptParsed", onScriptParsed);
  return scriptUrls;
}


// Event enrichment is CDP-round-trip heavy (resolveNode + getEventListeners +
// source fetch per node). Serial enrichment of a 300-node page was 1000+
// sequential round-trips per build — batch like Stage 4 does.
const EVENT_BATCH_SIZE = 20;

async function enrichNodesBatched(
  nodes: BehaviorNode[],
  cdp: CDPClient,
  scriptUrls: Map<string, string>,
  injectedData: InjectedRegistryData,
): Promise<void> {
  for (let i = 0; i < nodes.length; i += EVENT_BATCH_SIZE) {
    const batch = nodes.slice(i, i + EVENT_BATCH_SIZE);
    await Promise.all(
      batch.map(async (node) => {
        try {
          const events = await getNodeEvents(cdp, node.backendDOMNodeId, scriptUrls);
          if (events.length > 0) {
            node.events = deduplicateEvents(
              enrichFromInjectedData(events, injectedData),
            );
          }
        } catch (err) {
          // Node may have been removed from DOM between AXTree snapshot and now
          debugLog("stage-2: event enrichment failed for node", node.id, err);
        }
      }),
    );
  }
}

export async function enrichGraphWithEvents(
  graph: BehaviorGraph,
  cdp: CDPClient,
): Promise<void> {
  const scriptUrls = await collectScriptUrls(cdp);

  // Query injected registry once (covers all elements)
  const injectedData = await queryInjectedRegistry(cdp);

  const targets = Array.from(graph.nodes.values()).filter(
    (n) => INTERACTIVE_ROLES.has(n.role) && n.backendDOMNodeId !== 0,
  );
  await enrichNodesBatched(targets, cdp, scriptUrls, injectedData);

  await clearReactHandlerRegistry(cdp);
}

export async function enrichSpecificNodesWithEvents(
  graph: BehaviorGraph,
  cdp: CDPClient,
  nodeIds: Set<string>,
): Promise<void> {
  if (nodeIds.size === 0) return;

  const scriptUrls = await collectScriptUrls(cdp);
  const injectedData = await queryInjectedRegistry(cdp);

  const targets: BehaviorNode[] = [];
  for (const nodeId of nodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    if (!INTERACTIVE_ROLES.has(node.role)) continue;
    if (node.backendDOMNodeId === 0) continue;
    targets.push(node);
  }
  await enrichNodesBatched(targets, cdp, scriptUrls, injectedData);

  await clearReactHandlerRegistry(cdp);
}

async function getNodeEvents(
  cdp: CDPClient,
  backendDOMNodeId: number,
  scriptUrls: Map<string, string>,
): Promise<EventBinding[]> {
  // Resolve backend node to a Runtime object
  const resolveResult = (await cdp.send("DOM.resolveNode", {
    backendNodeId: backendDOMNodeId,
  })) as { object: { objectId?: string } };

  const objectId = resolveResult.object?.objectId;
  if (!objectId) return [];

  const events: EventBinding[] = [];

  // 1. Direct DOM event listeners via DOMDebugger
  const directEvents = await getDirectListeners(cdp, objectId, scriptUrls);
  events.push(...directEvents);

  // 2. React Fiber-based handlers
  const reactEvents = await getReactHandlers(cdp, objectId, scriptUrls);
  events.push(...reactEvents);

  // Release the object to avoid memory leaks
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});

  return events;
}

async function getDirectListeners(
  cdp: CDPClient,
  objectId: string,
  scriptUrls: Map<string, string>,
): Promise<EventBinding[]> {
  const result = (await cdp.send("DOMDebugger.getEventListeners", {
    objectId,
    depth: 0,
    pierce: false,
  })) as { listeners: CDPEventListener[] };

  const events: EventBinding[] = [];

  for (const listener of result.listeners ?? []) {
    let category: EventBinding["category"] = "unknown";
    let source: EventBinding["source"] | undefined;
    let fnName = "";

    // Try to get handler source for categorization
    if (listener.handler?.objectId) {
      try {
        const fnResult = (await cdp.send("Runtime.callFunctionOn", {
          objectId: listener.handler.objectId,
          functionDeclaration: "function() { return this.toString(); }",
          returnByValue: true,
        })) as { result: { value?: string } };

        const handlerSource = fnResult.result?.value ?? "";
        category = categorizeHandler(handlerSource);
        fnName = extractFunctionName(handlerSource);
      } catch (err) {
        // Handler may not be stringifiable
        debugLog("stage-2: handler stringify failed", err);
      }

      // Release handler object
      await cdp
        .send("Runtime.releaseObject", { objectId: listener.handler.objectId })
        .catch(() => {});
    }

    // Extract source location from listener metadata
    if (listener.scriptId) {
      source = {
        scriptUrl: scriptUrls.get(listener.scriptId) ?? `script:${listener.scriptId}`,
        lineNumber: listener.lineNumber ?? 0,
        columnNumber: listener.columnNumber ?? 0,
        functionName: fnName,
      };
    }

    events.push({
      eventType: listener.type,
      category,
      ...(source && { source }),
    });
  }

  return events;
}

async function getReactHandlers(
  cdp: CDPClient,
  objectId: string,
  scriptUrls: Map<string, string>,
): Promise<EventBinding[]> {
  // Walk the React fiber and stash each event handler on a temp window key
  // so we can introspect its [[FunctionLocation]] via Runtime.getProperties.
  const result = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const el = this;
      const handlers = [];

      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fiberKey) return handlers;

      window.__veil_react_handlers__ = window.__veil_react_handlers__ || {};
      const registry = window.__veil_react_handlers__;
      const baseId = '_v' + (Object.keys(registry).length);

      let fiber = el[fiberKey];
      for (let i = 0; i < 10 && fiber; i++) {
        const props = fiber.memoizedProps;
        if (props) {
          const eventMap = {
            onClick: 'click', onChange: 'change', onInput: 'input',
            onSubmit: 'submit', onFocus: 'focus', onBlur: 'blur',
            onKeyDown: 'keydown', onKeyUp: 'keyup', onMouseDown: 'mousedown',
            onMouseUp: 'mouseup', onMouseEnter: 'mouseenter',
            onMouseLeave: 'mouseleave', onTouchStart: 'touchstart',
            onScroll: 'scroll', onWheel: 'wheel',
          };
          for (const [prop, eventType] of Object.entries(eventMap)) {
            if (typeof props[prop] === 'function') {
              const handlerKey = baseId + '_' + handlers.length;
              registry[handlerKey] = props[prop];
              let handlerString = '';
              try { handlerString = props[prop].toString().slice(0, 500); } catch {}
              handlers.push({ eventType, handlerString, handlerKey });
            }
          }
          if (handlers.length > 0) break;
        }
        fiber = fiber.return;
      }
      return handlers;
    }`,
    returnByValue: true,
  })) as { result: { value?: ReactHandlerInfo[] } };

  const reactHandlers = result.result?.value ?? [];
  if (reactHandlers.length === 0) return [];

  const events: EventBinding[] = [];

  for (const handler of reactHandlers) {
    const source = await resolveHandlerLocation(cdp, handler.handlerKey, scriptUrls);
    events.push({
      eventType: handler.eventType,
      category: categorizeHandler(handler.handlerString),
      ...(source && { source }),
    });
  }

  return events;
}

/**
 * Introspect a stashed handler's [[FunctionLocation]] via CDP.
 * Returns the EventBinding.source if scriptId/line/col can be recovered.
 */
async function resolveHandlerLocation(
  cdp: CDPClient,
  handlerKey: string,
  scriptUrls: Map<string, string>,
): Promise<EventBinding["source"] | undefined> {
  try {
    const evalResult = (await cdp.send("Runtime.evaluate", {
      expression: `window.__veil_react_handlers__ && window.__veil_react_handlers__[${JSON.stringify(handlerKey)}]`,
      returnByValue: false,
    })) as { result?: { objectId?: string } };

    const handlerObjectId = evalResult.result?.objectId;
    if (!handlerObjectId) return undefined;

    try {
      const propsResult = (await cdp.send("Runtime.getProperties", {
        objectId: handlerObjectId,
        ownProperties: false,
        accessorPropertiesOnly: false,
        generatePreview: false,
      })) as { internalProperties?: CDPInternalProperty[] };

      const locProp = propsResult.internalProperties?.find(
        (p) => p.name === "[[FunctionLocation]]",
      );
      const loc = locProp?.value?.value;
      if (!loc?.scriptId) return undefined;

      return {
        scriptUrl: scriptUrls.get(loc.scriptId) ?? `script:${loc.scriptId}`,
        lineNumber: loc.lineNumber ?? 0,
        columnNumber: loc.columnNumber ?? 0,
        functionName: "",
      };
    } finally {
      await cdp
        .send("Runtime.releaseObject", { objectId: handlerObjectId })
        .catch(() => {});
    }
  } catch {
    return undefined;
  }
}

/** Best-effort cleanup of the temp registry left behind by getReactHandlers. */
async function clearReactHandlerRegistry(cdp: CDPClient): Promise<void> {
  await cdp
    .send("Runtime.evaluate", {
      expression: "delete window.__veil_react_handlers__",
      returnByValue: true,
    })
    .catch(() => {});
}

export /** Pull a handler's function name from its source: "function onClick(" ->
 * "onClick"; arrow/anonymous handlers yield "". Best-effort, never throws. */
function extractFunctionName(source: string): string {
  const m =
    source.match(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/) ||
    source.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:=|:)\s*(?:async\s*)?\(/);
  return m ? m[1] : "";
}

function categorizeHandler(
  source: string,
): EventBinding["category"] {
  if (!source) return "unknown";

  // API call patterns. `.send(` alone is too broad (XState actor.send,
  // res.send, analytics.send) — require it paired with an XHR object.
  if (
    /\bfetch\s*\(/.test(source) ||
    /XMLHttpRequest/.test(source) ||
    /\baxios[.(]/.test(source) ||
    /\$\.\s*ajax\b/.test(source) ||
    /\bxhr\b[\s\S]{0,40}\.send\s*\(/.test(source)
  ) {
    return "api_call";
  }

  // Navigation patterns. Bare `location`/`router` match any local var — require
  // the browser-object forms.
  if (
    /\b(?:window\.|document\.)?location\s*[.=]/.test(source) ||
    /history\.\s*(push|replace)State/.test(source) ||
    /\brouter\.(push|replace|navigate|go)\b/.test(source) ||
    /\bnavigate\s*\(/.test(source) ||
    /window\.open\s*\(/.test(source) ||
    /\.href\s*=/.test(source)
  ) {
    return "navigation";
  }

  // Form submit patterns. `form.*submit` matched react-hook-form on non-form
  // controls — require an actual .submit() call or a submit-handler name.
  if (
    /\.submit\s*\(\s*\)/.test(source) ||
    /\bhandleSubmit\b/.test(source) ||
    /\bonSubmit\b/.test(source)
  ) {
    return "form_submit";
  }

  // DOM mutation patterns
  if (
    /innerHTML/.test(source) ||
    /appendChild/.test(source) ||
    /removeChild/.test(source) ||
    /replaceChild/.test(source) ||
    /insertBefore/.test(source) ||
    /\bsetState\b/.test(source) ||
    /\bdispatch\b/.test(source) ||
    /\.render\s*\(/.test(source) ||
    /className/.test(source) ||
    /classList/.test(source) ||
    /style\s*[.=]/.test(source) ||
    /setAttribute/.test(source) ||
    /textContent/.test(source) ||
    /\.value\s*=/.test(source)
  ) {
    return "dom_mutation";
  }

  return "unknown";
}

function deduplicateEvents(events: EventBinding[]): EventBinding[] {
  const seen = new Set<string>();
  const result: EventBinding[] = [];

  for (const event of events) {
    const key = `${event.eventType}:${event.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(event);
    }
  }

  return result;
}

/**
 * Cross-reference unknown handler categories against injected runtime data.
 * Uses stack trace overlap between listener registrations and network/navigation
 * calls to infer what a handler actually does.
 */
function enrichFromInjectedData(
  events: EventBinding[],
  injectedData: InjectedRegistryData,
): EventBinding[] {
  if (
    injectedData.networkCalls.length === 0 &&
    injectedData.navigations.length === 0
  ) {
    return events;
  }

  // Pre-build sets of non-framework frames from network calls and navigations
  const networkFrameSets: Array<{ frames: Set<string>; method: string; url: string }> = [];
  for (const call of injectedData.networkCalls) {
    const parsed = parseStackFrames(call.stack);
    const appFrames = new Set(parsed.filter((f) => !isFrameworkFrame(f)));
    if (appFrames.size > 0) {
      networkFrameSets.push({ frames: appFrames, method: call.method, url: call.url });
    }
  }

  const navFrameSets: Array<{ frames: Set<string>; url: string }> = [];
  for (const nav of injectedData.navigations) {
    const parsed = parseStackFrames(nav.stack);
    const appFrames = new Set(parsed.filter((f) => !isFrameworkFrame(f)));
    if (appFrames.size > 0) {
      navFrameSets.push({ frames: appFrames, url: nav.url });
    }
  }

  // Build a map of listener registration stacks by eventType
  const listenerStacksByType = new Map<string, string[][]>();
  for (const entry of injectedData.listeners) {
    const parsed = parseStackFrames(entry.stack);
    const appFrames = parsed.filter((f) => !isFrameworkFrame(f));
    if (appFrames.length === 0) continue;
    let list = listenerStacksByType.get(entry.eventType);
    if (!list) {
      list = [];
      listenerStacksByType.set(entry.eventType, list);
    }
    list.push(appFrames);
  }

  for (const event of events) {
    if (event.category !== "unknown") continue;

    // Find injected listener stacks matching this event type
    const stacks = listenerStacksByType.get(event.eventType);
    if (!stacks) continue;

    let resolved = false;

    for (const listenerFrames of stacks) {
      if (resolved) break;

      // Check overlap with network call stacks
      for (const netEntry of networkFrameSets) {
        if (listenerFrames.some((f) => netEntry.frames.has(f))) {
          event.category = "api_call";
          event.estimatedEffect = `${netEntry.method} ${extractPath(netEntry.url)}`;
          resolved = true;
          break;
        }
      }

      if (resolved) break;

      // Check overlap with navigation stacks
      for (const navEntry of navFrameSets) {
        if (listenerFrames.some((f) => navEntry.frames.has(f))) {
          event.category = "navigation";
          event.estimatedEffect = extractPath(navEntry.url);
          resolved = true;
          break;
        }
      }
    }
  }

  return events;
}

