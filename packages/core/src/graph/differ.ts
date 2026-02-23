import type { AXNode } from "../browser/page.js";
import type { GraphDiff } from "./model.js";
import { shouldKeep, extractState } from "../pipeline/stage-1-axtree.js";

interface AXNodeFingerprint {
  role: string;
  name: string;
  description: string;
  value: string;
  stateHash: string;
  childIds: string[];
}

export interface DiffableSnapshot {
  fingerprints: Map<string, AXNodeFingerprint>;
}

function hashState(state: Record<string, string | boolean>): string {
  const keys = Object.keys(state).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}=${state[k]}`).join(",");
}

export function buildSnapshot(axNodes: AXNode[]): DiffableSnapshot {
  const fingerprints = new Map<string, AXNodeFingerprint>();

  for (const node of axNodes) {
    if (!shouldKeep(node)) continue;

    fingerprints.set(node.nodeId, {
      role: node.role?.value ?? "",
      name: node.name?.value ?? "",
      description: node.description?.value ?? "",
      value: node.value?.value ?? "",
      stateHash: hashState(extractState(node)),
      childIds: node.childIds ? [...node.childIds] : [],
    });
  }

  return { fingerprints };
}

export function diffSnapshots(
  oldSnap: DiffableSnapshot,
  newSnap: DiffableSnapshot,
): GraphDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  // New keys not in old → added
  for (const nodeId of newSnap.fingerprints.keys()) {
    if (!oldSnap.fingerprints.has(nodeId)) {
      added.push(nodeId);
    }
  }

  // Old keys not in new → removed
  for (const nodeId of oldSnap.fingerprints.keys()) {
    if (!newSnap.fingerprints.has(nodeId)) {
      removed.push(nodeId);
    }
  }

  // Shared keys — compare fingerprints
  for (const [nodeId, newFp] of newSnap.fingerprints) {
    const oldFp = oldSnap.fingerprints.get(nodeId);
    if (!oldFp) continue; // already in added

    if (
      oldFp.role !== newFp.role ||
      oldFp.name !== newFp.name ||
      oldFp.description !== newFp.description ||
      oldFp.value !== newFp.value ||
      oldFp.stateHash !== newFp.stateHash ||
      oldFp.childIds.length !== newFp.childIds.length ||
      oldFp.childIds.some((id, i) => id !== newFp.childIds[i])
    ) {
      modified.push(nodeId);
    }
  }

  return { added, removed, modified };
}
