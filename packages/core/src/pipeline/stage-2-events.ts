import type { CDPClient } from "../browser/cdp-client.js";
import type { BehaviorGraph, EventBinding } from "../graph/model.js";

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
}

export async function enrichGraphWithEvents(
  graph: BehaviorGraph,
  cdp: CDPClient,
): Promise<void> {
  // Collect script URL map by re-enabling Debugger (replays scriptParsed for all scripts)
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

  for (const [, node] of graph.nodes) {
    if (!INTERACTIVE_ROLES.has(node.role)) continue;
    if (node.backendDOMNodeId === 0) continue;

    try {
      const events = await getNodeEvents(cdp, node.backendDOMNodeId, scriptUrls);
      if (events.length > 0) {
        node.events = deduplicateEvents(events);
      }
    } catch {
      // Node may have been removed from DOM between AXTree snapshot and now — skip
    }
  }
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
  const reactEvents = await getReactHandlers(cdp, objectId);
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
      } catch {
        // Handler may not be stringifiable
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
        functionName: "",
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
): Promise<EventBinding[]> {
  const result = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const el = this;
      const handlers = [];

      // Find React Fiber key
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return handlers;

      let fiber = el[fiberKey];
      // Walk up Fiber tree (max 10 levels) to find event props
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
              try {
                handlers.push({ eventType, handlerString: props[prop].toString().slice(0, 500) });
              } catch {
                handlers.push({ eventType, handlerString: '' });
              }
            }
          }
          // Stop at first fiber with event props to avoid duplicates
          if (handlers.length > 0) break;
        }
        fiber = fiber.return;
      }
      return handlers;
    }`,
    returnByValue: true,
  })) as { result: { value?: ReactHandlerInfo[] } };

  const reactHandlers = result.result?.value ?? [];
  return reactHandlers.map((h) => ({
    eventType: h.eventType,
    category: categorizeHandler(h.handlerString),
  }));
}

export function categorizeHandler(
  source: string,
): EventBinding["category"] {
  if (!source) return "unknown";

  // API call patterns
  if (
    /\bfetch\s*\(/.test(source) ||
    /XMLHttpRequest/.test(source) ||
    /\baxios[.(]/.test(source) ||
    /\$\.\s*ajax\b/.test(source) ||
    /\.send\s*\(/.test(source)
  ) {
    return "api_call";
  }

  // Navigation patterns
  if (
    /location\s*[.=]/.test(source) ||
    /history\.\s*(push|replace)/.test(source) ||
    /\brouter\b/.test(source) ||
    /\bnavigate\s*\(/.test(source) ||
    /window\.open\s*\(/.test(source) ||
    /\.href\s*=/.test(source)
  ) {
    return "navigation";
  }

  // Form submit patterns
  if (
    /\.submit\s*\(/.test(source) ||
    /form.*submit/i.test(source) ||
    /handleSubmit/.test(source)
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

