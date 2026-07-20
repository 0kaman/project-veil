/**
 * Tools tested over the REAL in-memory MCP transport — the genuine protocol
 * path, no stdio process. Real Search + Reader sit behind a routing fetch, so
 * this exercises search → read → handle-pull end to end, exactly as an agent
 * would drive it. No network, no live Brave.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Search } from "@veil/search";
import { Reader } from "@veil/read";
import { registerVeilTools } from "../tools.js";

const BRAVE = JSON.stringify({
  web: {
    results: [
      {
        title: "HTTP explained",
        url: "https://example.org/http",
        description: "A guide to <strong>HTTP</strong>.",
      },
    ],
  },
});

const ARTICLE =
  "<!doctype html><title>HTTP explained</title><body><article>" +
  "<h1>HTTP explained</h1>" +
  Array.from({ length: 40 }, (_, i) => `<h2>Section ${i}</h2><p>${"word ".repeat(30)}The unique marker phrase zebra appears only in section ${i === 20 ? "twenty" : i}.</p>`).join("") +
  "</article></body>";

/** Routes by URL: the Brave endpoint returns results; anything else, the article. */
function routingFetch() {
  return async (url: string) => ({
    status: 200,
    url,
    text: async () => (url.includes("api.search.brave.com") ? BRAVE : ARTICLE),
  });
}

async function connect() {
  const server = new McpServer({ name: "veil-test", version: "0" });
  const fetchImpl = routingFetch();
  registerVeilTools(server, {
    search: new Search({ apiKey: "test", fetchImpl, minIntervalMs: 0 }),
    reader: new Reader({ fetchImpl, config: { budgetWords: 200 } }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}

const callText = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return { text: res.content.map((c) => c.text ?? "").join("\n"), isError: res.isError };
};

describe("veil MCP tools", () => {
  let ctx: Awaited<ReturnType<typeof connect>>;
  let client: Client;
  beforeEach(async () => {
    ctx = await connect();
    client = ctx.client;
  });

  it("exposes exactly the two verbs, described as signposts", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["veil_read", "veil_search"]);
    const read = tools.find((t) => t.name === "veil_read")!;
    expect(read.description).toMatch(/USE THIS/i);
    await ctx.close();
  });

  it("veil_search → receipt-led, projected results", async () => {
    const { text } = await callText(client, "veil_search", { query: "http" });
    expect(text).toMatch(/^via: brave/m);
    expect(text).toMatch(/HTTP explained/);
    expect(text).toMatch(/example\.org\/http/);
    await ctx.close();
  });

  it("veil_read a URL → receipt, title, outline, and a handle when truncated", async () => {
    const { text } = await callText(client, "veil_read", { url: "https://example.org/http" });
    expect(text).toMatch(/^via: fetch/m);
    expect(text).toMatch(/title: HTTP explained/);
    expect(text).toMatch(/outline:/);
    expect(text).toMatch(/handle r\d+/); // budget 200 forces truncation
    await ctx.close();
  });

  it("the whole flow: search → read → pull by handle", async () => {
    const url = (await callText(client, "veil_search", { query: "http" })).text.match(
      /https:\/\/\S+/,
    )![0];

    const read = await callText(client, "veil_read", { url });
    const handle = read.text.match(/handle (r\d+)/)![1];

    const pull = await callText(client, "veil_read", { url: handle, query: "zebra" });
    expect(pull.text).toMatch(new RegExp(`via: handle ${handle}`));
    expect(pull.text).toMatch(/zebra/);
    await ctx.close();
  });

  it("an unknown handle is reported, not silently empty", async () => {
    const { text } = await callText(client, "veil_read", { url: "r999", query: "x" });
    expect(text).toMatch(/No such handle/i);
    await ctx.close();
  });

  it("a doorman URL comes back as a readable receipt, not an error", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const fetchImpl = async (url: string) => ({ status: 403, url, text: async () => "" });
    registerVeilTools(server, {
      search: new Search({ apiKey: "k", fetchImpl, minIntervalMs: 0 }),
      reader: new Reader({ fetchImpl }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(st), c.connect(ct)]);
    const res = (await c.callTool({
      name: "veil_read",
      arguments: { url: "https://blocked.test/x" },
    })) as { content: { text?: string }[]; isError?: boolean };
    const text = res.content.map((x) => x.text ?? "").join("");
    expect(text).toMatch(/DOORMAN/);
    expect(res.isError).toBeFalsy(); // a receipt, not a protocol failure
    await c.close();
  });
});
