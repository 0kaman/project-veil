import type { NetworkEdge, ApiEndpoint } from "../graph/model.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Infer a flat JSON shape from a response/request body string.
 * Returns top-level key→type map, or null on parse failure.
 */
export function inferJsonShape(body: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  // If array, infer shape from first element
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    parsed = parsed[0];
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const shape: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (val === null) {
      shape[key] = "null";
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        shape[key] = "array";
      } else {
        const elemType = typeof val[0];
        shape[key] = elemType === "object" ? "object[]" : `${elemType}[]`;
      }
    } else {
      shape[key] = typeof val;
    }
  }
  return Object.keys(shape).length > 0 ? shape : null;
}

/**
 * Given a set of URLs (same method + prefix group), infer a parameterized pattern.
 * Varying numeric/UUID segments become {id}, other varying segments become {param}.
 */
export function inferUrlPattern(urls: string[]): string {
  if (urls.length === 0) return "/";

  const pathnames: string[] = [];
  let queryKeys: Set<string> | null = null;

  for (const raw of urls) {
    try {
      const u = new URL(raw);
      pathnames.push(u.pathname);
      if (u.search) {
        const keys = new Set(u.searchParams.keys());
        if (queryKeys === null) {
          queryKeys = keys;
        } else {
          // Union of all query keys
          for (const k of keys) queryKeys.add(k);
        }
      }
    } catch {
      // Skip malformed URLs
    }
  }

  if (pathnames.length === 0) return "/";
  if (pathnames.length === 1) {
    let result = pathnames[0];
    if (queryKeys && queryKeys.size > 0) {
      const params = [...queryKeys].map((k) => `${k}={${k}}`).join("&");
      result += `?${params}`;
    }
    return result;
  }

  // Split into segments, compare across URLs
  const segmented = pathnames.map((p) => p.split("/").filter(Boolean));
  const maxLen = Math.max(...segmented.map((s) => s.length));
  const pattern: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const values = new Set<string>();
    for (const segs of segmented) {
      if (i < segs.length) values.add(segs[i]);
    }

    if (values.size === 1) {
      // All URLs have the same segment here
      pattern.push([...values][0]);
    } else {
      // Varying segment — classify
      const allNumeric = [...values].every((v) => /^\d+$/.test(v));
      const allUuid = [...values].every((v) => UUID_PATTERN.test(v));
      pattern.push(allNumeric || allUuid ? "{id}" : "{param}");
    }
  }

  let result = "/" + pattern.join("/");
  if (queryKeys && queryKeys.size > 0) {
    const params = [...queryKeys].map((k) => `${k}={${k}}`).join("&");
    result += `?${params}`;
  }
  return result;
}

/**
 * Build a deduplicated API endpoint catalog from network edges.
 * Groups by method + first 2 path segments, infers patterns and merges shapes.
 */
export function buildApiEndpoints(edges: NetworkEdge[]): ApiEndpoint[] {
  // Group edges by method + path prefix (first 2 segments)
  const groups = new Map<string, NetworkEdge[]>();

  for (const edge of edges) {
    let pathname: string;
    try {
      pathname = new URL(edge.request.url).pathname;
    } catch {
      continue;
    }

    const segments = pathname.split("/").filter(Boolean);
    // Use first segment as group key; include second only if it's not a dynamic param
    let prefix = segments[0] ?? "";
    if (segments.length > 1 && !/^\d+$/.test(segments[1]) && !UUID_PATTERN.test(segments[1])) {
      prefix += "/" + segments[1];
    }
    const key = `${edge.request.method}:${prefix}`;

    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(edge);
  }

  const endpoints: ApiEndpoint[] = [];

  for (const [, group] of groups) {
    const method = group[0].request.method;
    const urls = group.map((e) => e.request.url);
    const pattern = inferUrlPattern(urls);

    // Merge response shapes (union of all observed fields)
    let responseShape: Record<string, string> | undefined;
    const statusCodes = new Set<number>();
    let contentType: string | undefined;
    let requestShape: Record<string, string> | undefined;

    for (const edge of group) {
      if (edge.response) {
        statusCodes.add(edge.response.status);
        if (edge.response.contentType) {
          contentType = shortType(edge.response.contentType);
        }
        if (edge.response.bodyShape) {
          if (!responseShape) {
            responseShape = { ...edge.response.bodyShape };
          } else {
            for (const [k, v] of Object.entries(edge.response.bodyShape)) {
              if (!responseShape[k]) responseShape[k] = v;
            }
          }
        }
      }
    }

    endpoints.push({
      pattern,
      method,
      responseShape,
      requestShape,
      statusCodes: [...statusCodes].sort((a, b) => a - b),
      contentType,
      count: group.length,
    });
  }

  // Sort by count descending
  endpoints.sort((a, b) => b.count - a.count);
  return endpoints;
}

function shortType(ct: string): string {
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("text/plain")) return "text";
  return ct.split(";")[0].trim() || "unknown";
}
