import type { CDPClient } from "./cdp-client.js";
import type { InteractAction } from "../graph/model.js";
import { VeilError } from "../graph/model.js";

interface BoxModelResult {
  model: {
    content: number[]; // [x1,y1, x2,y2, x3,y3, x4,y4]
  };
}

function centerOf(model: BoxModelResult): { x: number; y: number } {
  const q = model.model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x, y };
}

export async function dispatchInteraction(
  cdp: CDPClient,
  backendNodeId: number,
  action: InteractAction,
): Promise<void> {
  try {
    switch (action.action) {
      case "click":
        await dispatchClick(cdp, backendNodeId);
        break;
      case "type":
        await dispatchType(cdp, backendNodeId, action.text);
        break;
      case "clear":
        await dispatchClear(cdp, backendNodeId);
        break;
      case "select":
        await dispatchSelect(cdp, backendNodeId, action.value);
        break;
      case "focus":
        await dispatchFocus(cdp, backendNodeId);
        break;
      case "hover":
        await dispatchHover(cdp, backendNodeId);
        break;
    }
  } catch (err) {
    if (err instanceof VeilError) throw err;
    throw new VeilError(
      "INTERACTION_FAILED",
      `${action.action} failed on node ${backendNodeId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Bring the element into the viewport before reading its box model — the
 * content-quad coordinates are viewport-relative, so an element below the fold
 * (or inside a scroll container) would otherwise be clicked at a coordinate
 * that lands on whatever is currently visible there, not the target. */
async function scrollIntoView(cdp: CDPClient, backendNodeId: number): Promise<void> {
  try {
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Not all Chrome builds expose it, and detached nodes throw — fall back to
    // a JS scroll so the box model is still meaningful.
    try {
      const { objectId } = await resolveNode(cdp, backendNodeId);
      await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() { this.scrollIntoView({ block: "center", inline: "center" }); }`,
      });
    } catch {
      /* best effort */
    }
  }
}

async function dispatchClick(cdp: CDPClient, backendNodeId: number): Promise<void> {
  await scrollIntoView(cdp, backendNodeId);
  const boxModel = (await cdp.send("DOM.getBoxModel", { backendNodeId })) as BoxModelResult;
  const { x, y } = centerOf(boxModel);

  await cdp.send("DOM.focus", { backendNodeId });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function dispatchType(cdp: CDPClient, backendNodeId: number, text: string): Promise<void> {
  await scrollIntoView(cdp, backendNodeId);
  await cdp.send("DOM.focus", { backendNodeId });

  // Monaco editors (VS Code, LeetCode, etc.) mangle Input.insertText with auto-indent.
  // Use Monaco's API directly when detected.
  const monacoSet = await tryMonacoSetValue(cdp, backendNodeId, text);
  if (monacoSet) return;

  // Input.insertText inserts at the caret WITHOUT clearing — typing into a
  // pre-filled field would concatenate garbage. Clear first (SelectAll+Delete
  // keeps native editors, contenteditable, and framework inputs consistent),
  // then insert the intended value.
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 4, // Ctrl (Cmd on mac is 8, but Ctrl+A selects in inputs cross-platform)
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 4,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
  });
  await cdp.send("Input.insertText", { text });
}

async function tryMonacoSetValue(
  cdp: CDPClient,
  backendNodeId: number,
  text: string,
): Promise<boolean> {
  try {
    const { objectId } = await resolveNode(cdp, backendNodeId);
    const result = (await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(text) {
        const editorEl = this.closest?.('.monaco-editor');
        if (!editorEl) return false;
        const id = editorEl.getAttribute('data-uri')?.replace('inmemory://model/', '');
        const models = window.monaco?.editor?.getModels?.() ?? [];
        const model = id ? models.find(m => m.uri.path === '/' + id || m.uri.toString().includes(id)) : models[0];
        if (model) { model.setValue(text); return true; }
        return false;
      }`,
      arguments: [{ value: text }],
      returnByValue: true,
    })) as { result: { value: unknown } };
    return result.result?.value === true;
  } catch {
    return false;
  }
}

async function dispatchClear(cdp: CDPClient, backendNodeId: number): Promise<void> {
  const { objectId } = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    // `.value = ""` is a dead no-op on contenteditable / rich editors (Slate,
    // ProseMirror, Draft.js) — they have no value property. Branch on the
    // element type so "clear" actually clears rich fields too.
    functionDeclaration: `function() {
      if (this.isContentEditable) {
        this.textContent = "";
      } else if ("value" in this) {
        this.value = "";
      } else {
        this.textContent = "";
      }
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }`,
  });
}

async function dispatchSelect(cdp: CDPClient, backendNodeId: number, value: string): Promise<void> {
  const { objectId } = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(val) {
      this.value = val;
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }`,
    arguments: [{ value }],
  });
}

async function dispatchFocus(cdp: CDPClient, backendNodeId: number): Promise<void> {
  await cdp.send("DOM.focus", { backendNodeId });
}

async function dispatchHover(cdp: CDPClient, backendNodeId: number): Promise<void> {
  const boxModel = (await cdp.send("DOM.getBoxModel", { backendNodeId })) as BoxModelResult;
  const { x, y } = centerOf(boxModel);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
}

async function resolveNode(
  cdp: CDPClient,
  backendNodeId: number,
): Promise<{ objectId: string }> {
  const result = (await cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string };
  };
  return { objectId: result.object.objectId };
}
