// Core classes
export { Veil, VeilPage } from "@veil/core";

// Error
export { VeilError } from "@veil/core";

// Serializers
export { serializeCompactText, serializeJGF } from "@veil/core";

// Query + Display IDs
export { queryNodes, buildDisplayIdRegistry } from "@veil/core";

// Types
export type {
  BehaviorNode,
  BehaviorGraph,
  EventBinding,
  NetworkEdge,
  NetworkRequest,
  CallFrame,
  InteractAction,
  NodeFilter,
  VeilErrorCode,
  DisplayIdRegistry,
  GraphDiff,
  GraphChangeCallback,
} from "@veil/core";

// SDK-specific types
export type { OpenOptions, VeilOptions } from "./types.js";
