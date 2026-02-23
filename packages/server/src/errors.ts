import { VeilError } from "@veil/sdk";
import type { VeilErrorCode } from "@veil/sdk";
import type { ErrorEnvelope } from "./types.js";

const VEIL_ERROR_STATUS: Record<VeilErrorCode, number> = {
  NODE_NOT_FOUND: 404,
  NODE_NOT_INTERACTIVE: 422,
  INTERACTION_FAILED: 502,
};

export class ServerError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.code = code;
  }
}

export function toServerError(err: unknown): ServerError {
  if (err instanceof ServerError) return err;
  if (err instanceof VeilError) {
    const status = VEIL_ERROR_STATUS[err.code] ?? 500;
    return new ServerError(status, err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ServerError(500, "INTERNAL_ERROR", message);
}

export function errorResponse(err: unknown): { status: number; body: ErrorEnvelope } {
  const serverErr = toServerError(err);
  return {
    status: serverErr.status,
    body: {
      error: {
        code: serverErr.code,
        message: serverErr.message,
        status: serverErr.status,
      },
    },
  };
}
