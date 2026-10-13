import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { request, Agent, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { once } from "node:events";
import {
  createHttpApp,
  closeHttpServer,
  listenHttp,
  loadHttpConfig,
  ConfigError,
  MCP_PATH,
  HEALTH_PATH,
  type HttpConfig,
} from "../src/http.js";
import { parseBearerToken } from "../src/auth.js";
import { createServer, allTools, SERVER_INFO } from "../src/server.js";
import type { SevdeskClient } from "../src/client.js";

// Mixed case and digits, so that comparisons ignoring case or parts of the token fail the tests
const AUTH_TOKEN = "k7Qp2Zr9Xw4Lm8Nc3Vb6Hy1Td5Fs0GaJ2uE7oR4iW9qP3sD6fK1lZ8xC5vB0nMt"; // gitleaks:allow (synthetic test token)
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

// Offline stand-in for the sevdesk API; only GET is used by the tested tool
const fakeClient = {
  GET: async () => ({ data: { objects: [{ id: "1", name: "Test" }] }, error: undefined }),
} as unknown as SevdeskClient;

function baseConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    allowedHosts: [],
    allowedOrigins: [],
    bodyLimit: 1024,
    ...overrides,
  };
}

async function listen(
  config: HttpConfig,
  createMcpServer = () => createServer(fakeClient)
): Promise<{ server: Server; url: string }> {
  const app = createHttpApp(config, createMcpServer);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const initializeParams = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "vitest", version: "0.0.0" },
};

describe("loadHttpConfig", () => {
  it("sollte Defaults setzen und bei Loopback nur Loopback-Hosts erlauben", () => {
    const config = loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN });
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 3000,
      authToken: AUTH_TOKEN,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: [],
      bodyLimit: 10 * 1024 * 1024,
    });
  });

  it("sollte ohne MCP_ALLOWED_HOSTS bei 0.0.0.0 keine Host-Prüfung setzen", () => {
    const config = loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_HTTP_HOST: "0.0.0.0" });
    expect(config.allowedHosts).toEqual([]);
  });

  it("sollte Werte aus der Umgebung übernehmen", () => {
    const config = loadHttpConfig({
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      MCP_HTTP_HOST: "0.0.0.0",
      MCP_HTTP_PORT: "8080",
      MCP_ALLOWED_HOSTS: " Example.org , localhost ,",
      MCP_ALLOWED_ORIGINS: "https://claude.ai, http://localhost:6274",
      MCP_HTTP_BODY_LIMIT: "2MB",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.allowedHosts).toEqual(["example.org", "localhost"]);
    expect(config.allowedOrigins).toEqual(["https://claude.ai", "http://localhost:6274"]);
    expect(config.bodyLimit).toBe(2 * 1024 * 1024);
  });

  it("sollte ohne Token abbrechen", () => {
    expect(() => loadHttpConfig({})).toThrow(ConfigError);
  });

  it("sollte zu kurze Token ablehnen", () => {
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: "short" })).toThrow(/at least 32/);
  });

  it.each([`${"a".repeat(40)} x`, "ä".repeat(40), `"${"a".repeat(40)}"`, `${"a".repeat(40)}$x`, `${"a".repeat(40)}\`x`])(
    "sollte Token mit unzulässigen Zeichen ablehnen: %s",
    (token) => {
      expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: token })).toThrow(/may only contain/);
    }
  );

  it("sollte Token im RFC-6750-Zeichensatz akzeptieren", () => {
    const token = "AbC-._~+/0123456789abcdefghijklmnop==";
    expect(loadHttpConfig({ MCP_AUTH_TOKEN: token }).authToken).toBe(token);
  });

  it.each(["abc", "NaN", "Infinity", "0", "-5", "10 megabytes", "1e3", "512b", "101mb", "10gb"])(
    "sollte ungültiges Body-Limit %s ablehnen",
    (limit) => {
      expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_HTTP_BODY_LIMIT: limit })).toThrow(ConfigError);
    }
  );

  it.each(["https://example.org", "example.org:443", "example.org/path", "exa mple.org"])(
    "sollte ungültigen Eintrag %s in MCP_ALLOWED_HOSTS ablehnen",
    (host) => {
      expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_ALLOWED_HOSTS: host })).toThrow(ConfigError);
    }
  );

  it.each(["claude.ai", "https://claude.ai/", "https://claude.ai:443", "ftp://claude.ai", "null"])(
    "sollte ungültigen Eintrag %s in MCP_ALLOWED_ORIGINS ablehnen",
    (origin) => {
      expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_ALLOWED_ORIGINS: origin })).toThrow(ConfigError);
    }
  );

  it.each([
    ["1kb", 1024],
    ["1024b", 1024],
    ["100mb", 100 * 1024 * 1024],
  ])("sollte das Body-Limit %s an der Grenze akzeptieren", (limit, bytes) => {
    expect(loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_HTTP_BODY_LIMIT: limit }).bodyLimit).toBe(bytes);
  });

  it.each(["1023b", "102401kb"])("sollte das Body-Limit %s knapp außerhalb ablehnen", (limit) => {
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_HTTP_BODY_LIMIT: limit })).toThrow(ConfigError);
  });

  it.each(["[0:0:0:0:0:0:0:1]", "127.1", "0x7f.0.0.1", "bücher.de", "user@example.org"])(
    "sollte nicht normalisierten Host-Eintrag %s ablehnen",
    (host) => {
      expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_ALLOWED_HOSTS: host })).toThrow(ConfigError);
    }
  );

  it.each(["[::1]", "127.0.0.1", "xn--bcher-kva.de", "mcp.example.org"])(
    "sollte normalisierten Host-Eintrag %s akzeptieren",
    (host) => {
      expect(loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_ALLOWED_HOSTS: host }).allowedHosts).toEqual([host]);
    }
  );

  it("sollte einen MCP_AUTH_TOKEN gleich dem sevdesk-Token ablehnen", () => {
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, SEVDESK_API_TOKEN: AUTH_TOKEN })).toThrow(/must differ/);
  });

  it.each([
    ["1", 1],
    ["65535", 65535],
  ])("sollte den Port %s an der Grenze akzeptieren", (port, expected) => {
    expect(loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_HTTP_PORT: port }).port).toBe(expected);
  });

  it.each(["abc", "0", "70000", "80.5", "-1"])("sollte ungültigen Port %s ablehnen", (port) => {
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN, MCP_HTTP_PORT: port })).toThrow(ConfigError);
  });
});

describe("parseBearerToken", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["Basic abc", undefined],
    ["Bearer", undefined],
    ["Bearer ", undefined],
    ["Bearer a b", undefined],
    ["XBearer abc", undefined],
    ["Token abc", undefined],
    ["abc", undefined],
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["Bearer   abc  ", "abc"],
  ])("%j -> %j", (header, expected) => {
    expect(parseBearerToken(header)).toBe(expected);
  });
});

describe("HTTP-Transport", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await listen(baseConfig()));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sollte den Health-Check ohne Token beantworten", async () => {
    const res = await fetch(`${url}${HEALTH_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("sollte Anfragen ohne Token mit 401 ablehnen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="mcp-sevdesk"');
  });

  it("sollte falsche Token mit 401 und invalid_token ablehnen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${"b".repeat(64)}` },
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it.each([
    ["ohne letztes Zeichen", AUTH_TOKEN.slice(0, -1)],
    ["mit Suffix", `${AUTH_TOKEN}x`],
    ["mit Präfix", `x${AUTH_TOKEN}`],
    ["mit geändertem letzten Zeichen", `${AUTH_TOKEN.slice(0, -1)}u`],
    ["mit geändertem ersten Zeichen", `j${AUTH_TOKEN.slice(1)}`],
    ["mit geändertem Zeichen in der Mitte", `${AUTH_TOKEN.slice(0, 31)}Q${AUTH_TOKEN.slice(32)}`],
    ["nur die ersten 32 Zeichen", AUTH_TOKEN.slice(0, 32)],
    ["in Großbuchstaben", AUTH_TOKEN.toUpperCase()],
    ["in Kleinbuchstaben", AUTH_TOKEN.toLowerCase()],
  ])("sollte einen fast richtigen Token (%s) ablehnen", async (_label, token) => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(401);
  });

  it.each([`XBearer ${AUTH_TOKEN}`, `Bearer ${AUTH_TOKEN} extra`, `Token ${AUTH_TOKEN}`, AUTH_TOKEN])(
    "sollte den Authorization-Header %s ablehnen",
    async (header) => {
      const res = await fetch(`${url}${MCP_PATH}`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: header },
        body: rpc("initialize", initializeParams),
      });
      expect(res.status).toBe(401);
    }
  );

  it("sollte unauthentifizierte Anfragen ablehnen, bevor der Body gelesen wird", async () => {
    const invalid = await fetch(`${url}${MCP_PATH}`, { method: "POST", headers: MCP_HEADERS, body: "{not json" });
    expect(invalid.status).toBe(401);
    const oversized = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: rpc("tools/list", { padding: "x".repeat(4096) }),
    });
    expect(oversized.status).toBe(401);
  });

  it("sollte keine CORS-Header senden", async () => {
    // The Origin decision relies on browsers never getting a CORS grant for this endpoint
    const preflight = await fetch(`${url}${MCP_PATH}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(preflight.ok).toBe(false);
    const post = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}`, Origin: "https://evil.example" },
      body: rpc("initialize", initializeParams),
    });
    for (const response of [preflight, post]) {
      const corsHeaders = [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
      expect(corsHeaders).toEqual([]);
    }
  });

  it.each([
    ["Query-Parameter", `${MCP_PATH}?access_token=${AUTH_TOKEN}`, {}],
    ["Query-Parameter key", `${MCP_PATH}?key=${AUTH_TOKEN}`, {}],
    ["Cookie", MCP_PATH, { Cookie: `token=${AUTH_TOKEN}; access_token=${AUTH_TOKEN}` }],
    ["X-API-Key", MCP_PATH, { "X-API-Key": AUTH_TOKEN }],
    ["Proxy-Authorization", MCP_PATH, { "Proxy-Authorization": `Bearer ${AUTH_TOKEN}` }],
  ])("sollte den Token nur im Authorization-Header akzeptieren, nicht per %s", async (_label, path, headers) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...headers },
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(401);
  });

  it("sollte andere Auth-Schemata ablehnen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Basic ${AUTH_TOKEN}` },
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(401);
  });

  it("sollte mit gültigem Token initialisieren", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body.result.serverInfo).toEqual(SERVER_INFO);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("sollte alle Tools mit Beschreibungen optionaler Felder auflisten", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("tools/list"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const tools = body.result.tools as Array<{ name: string; inputSchema: any }>;
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(allTools).sort());

    const listVouchers = tools.find((t) => t.name === "list_vouchers")!;
    expect(listVouchers.inputSchema.properties.status).toMatchObject({
      type: "string",
      enum: ["50", "100", "1000"],
      description: expect.stringContaining("Voucher status"),
    });
    expect(listVouchers.inputSchema.required ?? []).not.toContain("status");

    const getVoucher = tools.find((t) => t.name === "get_voucher")!;
    expect(getVoucher.inputSchema.required).toEqual(["voucherId"]);
  });

  it("sollte ein Tool aufrufen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("tools/call", { name: "list_check_accounts", arguments: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ objects: [{ id: "1", name: "Test" }] });
  });

  it("sollte ungültige Argumente als Tool-Fehler melden", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("tools/call", { name: "get_voucher", arguments: { voucherId: "nope" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("voucherId");
  });

  it("sollte ungültiges JSON mit Parse-Error ohne Stacktrace beantworten", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe(-32700);
    expect(text).not.toContain("at ");
  });

  it("sollte zu große Bodies mit 413 ablehnen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("tools/list", { padding: "x".repeat(2048) }),
    });
    expect(res.status).toBe(413);
  });

  it("sollte alle Methoden außer POST mit 405 beantworten", async () => {
    for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"]) {
      const res = await fetch(`${url}${MCP_PATH}`, {
        method,
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("sollte GET ohne Token mit 401 statt 405 ablehnen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`);
    expect(res.status).toBe(401);
  });

  it.each([
    ["POST", "/MCP"],
    ["POST", "/mcp/"],
    ["POST", "/Mcp?x=1"],
    ["POST", "/mcp?x=1"],
    ["POST", "//mcp"],
    ["HEAD", "/mcp"],
    ["OPTIONS", "/mcp"],
    ["PUT", "/mcp"],
    ["GET", "/unknown"],
  ])("sollte %s %s ohne Token mit 401 ablehnen", async (method, path) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: MCP_HEADERS,
      body: method === "POST" || method === "PUT" ? rpc("tools/list") : undefined,
    });
    expect(res.status).toBe(401);
  });

  it("sollte unbekannte Pfade mit Token als 404 beantworten", async () => {
    const res = await fetch(`${url}/unknown`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("sollte keine listChanged-Fähigkeit ankündigen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("initialize", initializeParams),
    });
    const body = await res.json();
    expect(body.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it("sollte keinen X-Powered-By-Header senden", async () => {
    const res = await fetch(`${url}${HEALTH_PATH}`);
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

describe("HTTP-Transport mit Host-Validierung", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await listen(baseConfig({ allowedHosts: ["mcp.example.org"] })));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sollte fremde Host-Header mit 403 ablehnen", async () => {
    const res = await fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
      body: rpc("initialize", initializeParams),
    });
    expect(res.status).toBe(403);
  });

  it("sollte erlaubte Host-Header durchlassen", async () => {
    // fetch() does not allow overriding the Host header, so use node:http directly
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: MCP_PATH,
          method: "POST",
          headers: { ...MCP_HEADERS, Host: "mcp.example.org", Authorization: `Bearer ${AUTH_TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end(rpc("initialize", initializeParams));
    });
    expect(status).toBe(200);
  });

  it("sollte den Health-Check trotz Host-Validierung erlauben", async () => {
    const res = await fetch(`${url}${HEALTH_PATH}`);
    expect(res.status).toBe(200);
  });
});

describe("HTTP-Transport: Lebenszyklus pro Anfrage", () => {
  it("sollte den MCP-Server nach jeder Anfrage schließen", async () => {
    const created: Array<ReturnType<typeof createServer>> = [];
    const factory = () => {
      const server = createServer(fakeClient);
      vi.spyOn(server, "close");
      created.push(server);
      return server;
    };
    const { server, url } = await listen(baseConfig(), factory);
    try {
      const res = await fetch(`${url}${MCP_PATH}`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}` },
        body: rpc("tools/list"),
      });
      expect(res.status).toBe(200);
      await res.text();
      await vi.waitFor(() => expect(created[0].close).toHaveBeenCalled());
      expect(created).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("HTTP-Transport mit Origin-Validierung", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await listen(baseConfig({ allowedOrigins: ["https://claude.ai"] })));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function initializeWithOrigin(origin?: string) {
    return fetch(`${url}${MCP_PATH}`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${AUTH_TOKEN}`,
        ...(origin ? { Origin: origin } : {}),
      },
      body: rpc("initialize", initializeParams),
    });
  }

  it("sollte erlaubte Origins durchlassen", async () => {
    expect((await initializeWithOrigin("https://claude.ai")).status).toBe(200);
  });

  it("sollte Anfragen ohne Origin durchlassen", async () => {
    expect((await initializeWithOrigin()).status).toBe(200);
  });

  it.each(["https://evil.example", "https://claude.ai.evil.example", "https://evil.example/https://claude.ai", "http://claude.ai", "https://claude.ai:8443", "null"])(
    "sollte den Origin %s mit 403 ablehnen",
    async (origin) => {
      expect((await initializeWithOrigin(origin)).status).toBe(403);
    }
  );

  it("sollte einen leeren Origin-Header mit 403 ablehnen", async () => {
    // fetch() may drop an empty header, so use node:http directly
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: MCP_PATH,
          method: "POST",
          headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}`, Origin: "" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end(rpc("initialize", initializeParams));
    });
    expect(status).toBe(403);
  });

  it("sollte Origins unabhängig von Groß-/Kleinschreibung vergleichen", async () => {
    expect((await initializeWithOrigin("HTTPS://CLAUDE.AI")).status).toBe(200);
  });
});

describe("closeHttpServer", () => {
  // Sockets and servers of a failed test are released right away instead of at worker exit
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function track(server: Server): Server {
    cleanups.push(() => {
      server.closeAllConnections();
      if (server.listening) {
        server.close();
      }
    });
    return server;
  }

  // Fails with a clear message instead of running into the 30s test timeout
  async function within<T>(promise: Promise<T>, what: string, ms = 5_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
  }

  function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  const toolCall = rpc("tools/call", { name: "list_check_accounts", arguments: {} });

  // sevdesk stand-in that signals when the tool runs and answers only once released
  function blockingClient(result: unknown = { objects: [] }) {
    const started = deferred();
    const release = deferred();
    const client = {
      GET: async () => {
        started.resolve();
        await release.promise;
        return { data: result, error: undefined };
      },
    } as unknown as SevdeskClient;
    return { client, started, release };
  }

  function rawPost(port: number, agent: Agent, body: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: MCP_PATH,
          method: "POST",
          agent,
          headers: { ...MCP_HEADERS, Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Length": Buffer.byteLength(body) },
        },
        resolve
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  function readBody(res: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
    });
  }

  it("sollte laufende Anfragen beenden lassen und die Verbindung danach schließen", async () => {
    const { client, started, release } = blockingClient();
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true });

    try {
      const response = rawPost(port, agent, toolCall);
      await within(started.promise, "the request to reach the handler");

      const closed = closeHttpServer(server);
      release.resolve();
      const res = await within(response, "the response");
      expect(res.statusCode).toBe(200);
      // The client must not reuse a connection that is about to be closed
      expect(res.headers.connection).toBe("close");
      expect(JSON.parse((await within(readBody(res), "the response body")).toString()).result.isError).toBeFalsy();
      // Resolves only once the keep-alive connection is closed, not after the 95s keep-alive timeout
      await within(closed, "the server to close");
    } finally {
      agent.destroy();
    }
  });

  it("sollte große Antworten an langsame Clients vollständig ausliefern", async () => {
    const big = { objects: "x".repeat(32 * 1024 * 1024) };
    const fastClient = { GET: async () => ({ data: big, error: undefined }) } as unknown as SevdeskClient;
    const app = createHttpApp(baseConfig(), () => createServer(fastClient));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true });

    try {
      // The response has ended on the server, but most of it is still buffered
      const res = await rawPost(port, agent, toolCall);
      res.pause();
      const closed = closeHttpServer(server);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const body = readBody(res);
      res.resume();
      const received = await within(body, "the response body");
      expect(received.length).toBe(Number(res.headers["content-length"]));
      expect(JSON.parse(received.toString()).result.isError).toBeFalsy();
      await within(closed, "the server to close");
    } finally {
      agent.destroy();
    }
  }, 30_000);

  it("sollte ruhende Keep-Alive-Verbindungen und Verbindungen ohne Anfrage sofort schließen", async () => {
    const app = createHttpApp(baseConfig(), () => createServer(fakeClient));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true });

    try {
      const res = await rawPost(port, agent, rpc("tools/list"));
      await within(readBody(res), "the response body");
      // Second connection that only sends part of a request
      const halfOpen = connect(port, "127.0.0.1");
      await once(halfOpen, "connect");
      halfOpen.write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      halfOpen.on("error", () => undefined);

      const started = Date.now();
      await within(closeHttpServer(server), "the server to close");
      expect(Date.now() - started).toBeLessThan(2_000);
      halfOpen.destroy();
    } finally {
      agent.destroy();
    }
  });

  interface QueuedCall {
    started: Deferred;
    release: Deferred;
    taken: boolean;
  }

  // Each call waits until the test releases it; calls are served in arrival order
  function queuedClient() {
    const calls: QueuedCall[] = [];
    const next = () => {
      const call: QueuedCall = { started: deferred(), release: deferred(), taken: false };
      calls.push(call);
      return call;
    };
    const client = {
      GET: async () => {
        const call = calls.find((candidate) => !candidate.taken);
        if (!call) {
          throw new Error("Unexpected sevdesk call");
        }
        call.taken = true;
        call.started.resolve();
        await call.release.promise;
        return { data: { objects: [] }, error: undefined };
      },
    } as unknown as SevdeskClient;
    return { client, next };
  }

  function rawRequest(id: number): string {
    const body = rpc("tools/call", { name: "list_check_accounts", arguments: {} }, id);
    return (
      `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${AUTH_TOKEN}\r\n` +
      `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
  }

  async function rawConnection(port: number) {
    const socket = connect(port, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    await once(socket, "connect");
    let received = "";
    socket.on("data", (chunk: Buffer) => (received += chunk.toString()));
    socket.on("error", () => undefined);
    return { socket, received: () => received, closed: once(socket, "close") };
  }

  it("sollte bei Pipelining beide beim Shutdown laufenden Anfragen beantworten", async () => {
    const { client, next } = queuedClient();
    const first = next();
    const second = next();
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;
    const connection = await rawConnection(port);

    connection.socket.write(rawRequest(1) + rawRequest(2));
    await within(first.started.promise, "the first request to reach the handler");
    await within(second.started.promise, "the second request to reach the handler");
    const closed = closeHttpServer(server);
    first.release.resolve();
    second.release.resolve();
    await within(connection.closed, "the connection to close");
    await within(closed, "the server to close");

    const received = connection.received();
    expect(received.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    expect(received).toContain('"id":1');
    expect(received).toContain('"id":2');
    // Only the last response announces the close, otherwise the second one would be lost
    expect(received.match(/\r\nConnection: close\r\n/gi)).toHaveLength(1);
    expect(received.lastIndexOf("Connection: close")).toBeGreaterThan(received.indexOf('"id":1'));
  });

  it("sollte eine nach Shutdown-Beginn gepipelinte Anfrage noch beantworten", async () => {
    const { client, next } = queuedClient();
    const first = next();
    const second = next();
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;
    const connection = await rawConnection(port);

    connection.socket.write(rawRequest(1));
    await within(first.started.promise, "the first request to reach the handler");
    const closed = closeHttpServer(server);
    connection.socket.write(rawRequest(2));
    await within(second.started.promise, "the second request to reach the handler");
    first.release.resolve();
    second.release.resolve();
    await within(connection.closed, "the connection to close");
    await within(closed, "the server to close");

    expect(connection.received().match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    expect(connection.received().match(/\r\nConnection: close\r\n/gi)).toHaveLength(1);
  });

  // sevdesk stand-in: the first call returns a large result, every call waits for its release
  function stagedClient(firstResult: unknown) {
    const calls: QueuedCall[] = [];
    const next = () => {
      const call: QueuedCall = { started: deferred(), release: deferred(), taken: false };
      calls.push(call);
      return call;
    };
    let count = 0;
    const client = {
      GET: async () => {
        const call = calls.find((candidate) => !candidate.taken);
        if (!call) {
          throw new Error("Unexpected sevdesk call");
        }
        call.taken = true;
        count += 1;
        const result = count === 1 ? firstResult : { objects: [] };
        call.started.resolve();
        await call.release.promise;
        return { data: result, error: undefined };
      },
    } as unknown as SevdeskClient;
    return { client, next, count: () => count };
  }

  it("sollte eine Anfrage hinter einer schon ohne close gesendeten Antwort noch beantworten", async () => {
    const { client, next } = stagedClient({ objects: "x".repeat(32 * 1024 * 1024) });
    const first = next();
    const second = next();
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const serverResponses: ServerResponse[] = [];
    server.on("request", (_req, res) => serverResponses.push(res));
    const { port } = server.address() as AddressInfo;
    const connection = await rawConnection(port);

    // The large first response sends its headers (keep-alive) before shutdown and stays unfinished
    connection.socket.pause();
    connection.socket.write(rawRequest(1));
    await within(first.started.promise, "the first request to reach the handler");
    first.release.resolve();
    await vi.waitFor(() => expect(serverResponses[0]?.headersSent).toBe(true), { timeout: 10_000 });
    const closed = closeHttpServer(server);
    connection.socket.write(rawRequest(2));
    await within(second.started.promise, "the second request to reach the handler");
    second.release.resolve();
    connection.socket.resume();
    await within(connection.closed, "the connection to close");
    await within(closed, "the server to close");

    const received = connection.received();
    expect(received.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    expect(received.match(/\r\nConnection: close\r\n/gi)).toHaveLength(1);
    expect(received.lastIndexOf("Connection: close")).toBeGreaterThan(received.indexOf("HTTP/1.1 200 OK", 1));
  }, 30_000);

  it("sollte die Ankündigung über mehrere nachgereichte Anfragen bis zur letzten weitergeben", async () => {
    const { client, next, count } = stagedClient({ objects: "x".repeat(32 * 1024 * 1024) });
    const first = next();
    const second = next();
    const third = next();
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const serverResponses: ServerResponse[] = [];
    server.on("request", (_req, res) => serverResponses.push(res));
    const { port } = server.address() as AddressInfo;
    const connection = await rawConnection(port);

    connection.socket.pause();
    connection.socket.write(rawRequest(1));
    await within(first.started.promise, "the first request to reach the handler");
    const closed = closeHttpServer(server);
    // The announcement moves from the first to the second response
    connection.socket.write(rawRequest(2));
    await within(second.started.promise, "the second request to reach the handler");
    // The first response sends its headers without the announcement and stays unfinished
    first.release.resolve();
    await vi.waitFor(() => expect(serverResponses[0]?.headersSent).toBe(true), { timeout: 10_000 });
    // A third request must still be processed and take over the announcement
    connection.socket.write(rawRequest(3));
    await within(third.started.promise, "the third request to reach the handler");
    second.release.resolve();
    third.release.resolve();
    connection.socket.resume();
    await within(connection.closed, "the connection to close");
    await within(closed, "the server to close");

    const received = connection.received();
    expect(count()).toBe(3);
    expect(received.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(3);
    expect(received.match(/\r\nConnection: close\r\n/gi)).toHaveLength(1);
    expect(received.lastIndexOf("Connection: close")).toBeGreaterThan(received.indexOf('"id":2'));
  }, 30_000);

  it.each([1, 2])("sollte %i späte Anfrage(n) nach einem schon gesendeten Connection: close nicht ausführen", async (late) => {
    // A large first response is still being sent when further requests arrive on the same connection
    let calls = 0;
    const first = blockingClient({ objects: "x".repeat(32 * 1024 * 1024) });
    const client = {
      GET: async () => {
        calls += 1;
        return (first.client as unknown as { GET: () => Promise<unknown> }).GET();
      },
    } as unknown as SevdeskClient;
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;
    const connection = await rawConnection(port);

    const serverResponses: ServerResponse[] = [];
    server.on("request", (_req, res) => serverResponses.push(res));

    // Do not read, so the large first response cannot be delivered and stays unfinished
    connection.socket.pause();
    connection.socket.write(rawRequest(1));
    await within(first.started.promise, "the first request to reach the handler");
    const closed = closeHttpServer(server);
    first.release.resolve();
    // The first response has sent its headers, including "Connection: close"
    await vi.waitFor(() => expect(serverResponses[0]?.headersSent).toBe(true), { timeout: 10_000 });
    connection.socket.write(Array.from({ length: late }, (_, index) => rawRequest(index + 2)).join(""));
    await vi.waitFor(() => expect(serverResponses).toHaveLength(1 + late), { timeout: 10_000 });
    // Give a wrongly started handler the chance to reach sevdesk
    await new Promise((resolve) => setTimeout(resolve, 200));
    connection.socket.resume();
    await within(connection.closed, "the connection to close");
    await within(closed, "the server to close");

    expect(connection.received().match(/HTTP\/1\.1 200 OK/g)).toHaveLength(1);
    expect(connection.received()).toContain("Connection: close");
    // The late requests were never processed, so nothing ran without a response
    expect(calls).toBe(1);
  }, 30_000);

  it("sollte bei Pipelining alle Antworten einer Verbindung ausliefern", async () => {
    // First request answers immediately, the second one only after shutdown has started
    let calls = 0;
    const second = blockingClient();
    const secondGet = (second.client as unknown as { GET: () => Promise<unknown> }).GET;
    const client = {
      GET: async () => {
        calls += 1;
        return calls === 1 ? { data: { objects: [] }, error: undefined } : secondGet();
      },
    } as unknown as SevdeskClient;
    const app = createHttpApp(baseConfig(), () => createServer(client));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    const { port } = server.address() as AddressInfo;

    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    let received = "";
    socket.on("data", (chunk: Buffer) => (received += chunk.toString()));
    const ended = once(socket, "close");
    const raw = (id: number) => {
      const body = rpc("tools/call", { name: "list_check_accounts", arguments: {} }, id);
      return (
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${AUTH_TOKEN}\r\n` +
        `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
    };
    // Both requests in one write, as a pipelining client sends them
    socket.write(raw(1) + raw(2));

    await within(second.started.promise, "the second request to reach the handler");
    const closed = closeHttpServer(server);
    second.release.resolve();
    await within(ended, "the connection to close");
    await within(closed, "the server to close");

    expect(received.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    // Only the response that was still pending at shutdown announces the close
    expect(received.match(/\r\nConnection: close\r\n/gi)).toHaveLength(1);
    expect(received).toContain('"id":1');
    expect(received).toContain('"id":2');
  });

  it("sollte Keep-Alive- und Header-Timeout passend zu Traefik setzen", async () => {
    const app = createHttpApp(baseConfig(), () => createServer(fakeClient));
    const server = track(await listenHttp(app, 0, "127.0.0.1"));
    try {
      expect(server.keepAliveTimeout).toBe(95_000);
      expect(server.headersTimeout).toBe(100_000);
    } finally {
      await closeHttpServer(server);
    }
  });

  it("sollte einen belegten Port als Konfigurationsfehler melden", async () => {
    const app = createHttpApp(baseConfig(), () => createServer(fakeClient));
    const first = await listenHttp(app, 0, "127.0.0.1");
    const { port } = first.address() as AddressInfo;
    try {
      const error = await listenHttp(app, port, "127.0.0.1").catch((e) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toBe(
        `cannot listen on 127.0.0.1:${port} (EADDRINUSE), check MCP_HTTP_HOST and MCP_HTTP_PORT`
      );
    } finally {
      await closeHttpServer(first);
    }
  });

  // Fake app whose listen() fails like Node does, to cover codes that are hard to provoke in tests
  function failingApp(code: string) {
    return {
      listen: (_port: number, _host: string, callback: (error?: Error) => void) => {
        setImmediate(() => callback(Object.assign(new Error(`listen ${code}`), { code })));
        return {};
      },
    } as unknown as Parameters<typeof listenHttp>[0];
  }

  it.each(["EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EAI_AGAIN"])(
    "sollte den Listen-Fehler %s als Konfigurationsfehler melden",
    async (code) => {
      const error = await listenHttp(failingApp(code), 3000, "mcp.example.org").catch((e) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toBe(
        `cannot listen on mcp.example.org:3000 (${code}), check MCP_HTTP_HOST and MCP_HTTP_PORT`
      );
    }
  );

  it("sollte andere Listen-Fehler unverändert weitergeben", async () => {
    const error = await listenHttp(failingApp("EINVAL"), 3000, "127.0.0.1").catch((e) => e);
    expect(error).not.toBeInstanceOf(ConfigError);
    expect(error.code).toBe("EINVAL");
  });

  it("sollte eine nicht vorhandene Adresse als Konfigurationsfehler melden", async () => {
    // 192.0.2.1 is reserved for documentation (RFC 5737) and never assigned to this host
    const app = createHttpApp(baseConfig(), () => createServer(fakeClient));
    const error = await listenHttp(app, 0, "192.0.2.1").catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("(EADDRNOTAVAIL)");
  });

  it("sollte Server ohne listenHttp ablehnen", async () => {
    const app = createHttpApp(baseConfig(), () => createServer(fakeClient));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      await expect(closeHttpServer(server)).rejects.toThrow(/listenHttp/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
