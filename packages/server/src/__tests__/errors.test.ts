import { describe, it, expect } from "vitest";
import { ServerError, toServerError, errorResponse } from "../errors.js";
import { VeilError } from "@veil/sdk";

describe("ServerError", () => {
  it("sets status, code, and message", () => {
    const err = new ServerError(400, "BAD_REQUEST", "something went wrong");
    expect(err.status).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toBe("something went wrong");
    expect(err.name).toBe("ServerError");
  });

  it("is an instance of Error", () => {
    const err = new ServerError(500, "INTERNAL", "oops");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ServerError);
  });
});

describe("toServerError", () => {
  it("passes through ServerError unchanged", () => {
    const original = new ServerError(422, "CUSTOM", "custom error");
    const result = toServerError(original);
    expect(result).toBe(original);
    expect(result.status).toBe(422);
    expect(result.code).toBe("CUSTOM");
  });

  it("converts VeilError NODE_NOT_FOUND to 404", () => {
    const veilErr = new VeilError("NODE_NOT_FOUND", "node 42 not found");
    const result = toServerError(veilErr);
    expect(result).toBeInstanceOf(ServerError);
    expect(result.status).toBe(404);
    expect(result.code).toBe("NODE_NOT_FOUND");
    expect(result.message).toBe("node 42 not found");
  });

  it("converts VeilError NODE_NOT_INTERACTIVE to 422", () => {
    const veilErr = new VeilError("NODE_NOT_INTERACTIVE", "not interactive");
    const result = toServerError(veilErr);
    expect(result.status).toBe(422);
    expect(result.code).toBe("NODE_NOT_INTERACTIVE");
  });

  it("converts VeilError INTERACTION_FAILED to 502", () => {
    const veilErr = new VeilError("INTERACTION_FAILED", "click failed");
    const result = toServerError(veilErr);
    expect(result.status).toBe(502);
    expect(result.code).toBe("INTERACTION_FAILED");
  });

  it("wraps unknown Error as 500 INTERNAL_ERROR", () => {
    const err = new Error("unexpected problem");
    const result = toServerError(err);
    expect(result).toBeInstanceOf(ServerError);
    expect(result.status).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toBe("unexpected problem");
  });

  it("wraps non-Error values as 500 INTERNAL_ERROR", () => {
    const result = toServerError("string error");
    expect(result.status).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toBe("string error");
  });

  it("wraps null as 500 INTERNAL_ERROR", () => {
    const result = toServerError(null);
    expect(result.status).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toBe("null");
  });
});

describe("errorResponse", () => {
  it("returns correct status and ErrorEnvelope for ServerError", () => {
    const err = new ServerError(400, "INVALID_REQUEST", "bad input");
    const { status, body } = errorResponse(err);
    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "bad input",
        status: 400,
      },
    });
  });

  it("returns 500 envelope for unknown errors", () => {
    const { status, body } = errorResponse(new Error("boom"));
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("boom");
    expect(body.error.status).toBe(500);
  });

  it("converts VeilError and returns correct envelope", () => {
    const veilErr = new VeilError("NODE_NOT_FOUND", "missing node");
    const { status, body } = errorResponse(veilErr);
    expect(status).toBe(404);
    expect(body.error.code).toBe("NODE_NOT_FOUND");
    expect(body.error.message).toBe("missing node");
    expect(body.error.status).toBe(404);
  });
});
