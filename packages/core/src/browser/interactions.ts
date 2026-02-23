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

async function dispatchClick(cdp: CDPClient, backendNodeId: number): Promise<void> {
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
  await cdp.send("DOM.focus", { backendNodeId });
  await cdp.send("Input.insertText", { text });
}

async function dispatchClear(cdp: CDPClient, backendNodeId: number): Promise<void> {
  const { objectId } = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      this.value = "";
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
