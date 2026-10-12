import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { Server as NetServer, type Socket } from "node:net";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { requireStaticBearerToken } from "./auth.js";
import { ConfigError } from "./config.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const LOOPBACK_BIND_ADDRESSES = ["127.0.0.1", "localhost", "::1"];
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

const MIN_AUTH_TOKEN_LENGTH = 32;
// RFC 6750 b64token; also rules out characters that break .env or compose interpolation
const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

const BODY_LIMIT_PATTERN = /^(\d+)(b|kb|mb)$/;
const BODY_LIMIT_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024 };
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;
const MIN_BODY_LIMIT = 1024;
const MAX_BODY_LIMIT = 100 * 1024 * 1024;

// Must exceed the idle timeout of upstream proxies (Traefik keeps idle backend
// connections for 90s), otherwise a proxy may reuse a connection Node just closed.
const KEEP_ALIVE_TIMEOUT_MS = 95_000;
const HEADERS_TIMEOUT_MS = 100_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface HttpConfig {
  host: string;
  port: number;
  authToken: string;
  /** Hostnames accepted in the Host header; empty disables the check. */
  allowedHosts: string[];
  /** Origins accepted in the Origin header; empty disables the check. */
  allowedOrigins: string[];
  /** Maximum JSON body size in bytes. */
  bodyLimit: number;
}

export { ConfigError };

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`MCP_HTTP_PORT must be an integer, got "${value}"`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`MCP_HTTP_PORT must be between 1 and 65535, got ${port}`);
  }
  return port;
}

function parseAuthToken(value: string | undefined, sevdeskToken: string | undefined): string {
  if (value === undefined || value === "") {
    throw new ConfigError("MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http");
  }
  if (value === sevdeskToken) {
    throw new ConfigError("MCP_AUTH_TOKEN must differ from SEVDESK_API_TOKEN");
  }
  if (!AUTH_TOKEN_PATTERN.test(value)) {
    throw new ConfigError(
      "MCP_AUTH_TOKEN may only contain letters, digits and - . _ ~ + / (optionally followed by =)"
    );
  }
  if (value.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters long (e.g. openssl rand -hex 32)`
    );
  }
  return value;
}

function parseBodyLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_BODY_LIMIT;
  }
  const match = BODY_LIMIT_PATTERN.exec(value.trim().toLowerCase());
  if (!match) {
    throw new ConfigError(`MCP_HTTP_BODY_LIMIT must be a size like 512kb or 10mb, got "${value}"`);
  }
  const bytes = Number(match[1]) * BODY_LIMIT_UNITS[match[2]];
  if (bytes < MIN_BODY_LIMIT || bytes > MAX_BODY_LIMIT) {
    throw new ConfigError(`MCP_HTTP_BODY_LIMIT must be between 1kb and 100mb, got "${value}"`);
  }
  return bytes;
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * The SDK compares the Host header after normalizing it with the URL parser, so
 * an entry only ever matches if it is already in that normalized form (no
 * scheme, port or path, punycode for IDNs, canonical IP notation).
 */
function normalizeHostname(entry: string): string | undefined {
  try {
    return new URL(`http://${entry}`).hostname;
  } catch {
    return undefined;
  }
}

function parseAllowedHosts(value: string | undefined, bindHost: string): string[] {
  const hosts = parseList(value);
  for (const host of hosts) {
    const normalized = normalizeHostname(host);
    if (normalized !== host) {
      const hint = normalized ? ` (normalized form: "${normalized}")` : "";
      throw new ConfigError(
        `MCP_ALLOWED_HOSTS entries must be bare hostnames without scheme, port or path, got "${host}"${hint}`
      );
    }
  }
  // Same default as the SDK: a server bound to loopback only answers to loopback names
  if (hosts.length === 0 && LOOPBACK_BIND_ADDRESSES.includes(bindHost)) {
    return [...LOOPBACK_HOSTNAMES];
  }
  return hosts;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = parseList(value);
  for (const origin of origins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new ConfigError(
        `MCP_ALLOWED_ORIGINS entries must be origins like https://example.org, got "${origin}"`
      );
    }
  }
  return origins;
}

/**
 * Reads the HTTP transport configuration from environment variables.
 * Throws a ConfigError on missing or invalid values.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const host = env.MCP_HTTP_HOST?.trim() || DEFAULT_HOST;
  return {
    host,
    port: parsePort(env.MCP_HTTP_PORT),
    authToken: parseAuthToken(env.MCP_AUTH_TOKEN, env.SEVDESK_API_TOKEN),
    allowedHosts: parseAllowedHosts(env.MCP_ALLOWED_HOSTS, host),
    allowedOrigins: parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS),
    bodyLimit: parseBodyLimit(env.MCP_HTTP_BODY_LIMIT),
  };
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/**
 * Rejects requests whose Origin header is present but not allowed, as required
 * by the MCP transport specification. Requests without an Origin header (all
 * non-browser clients) pass.
 */
function originValidation(allowedOrigins: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || allowedOrigins.includes(origin.toLowerCase())) {
      next();
      return;
    }
    res.status(403).json(jsonRpcError(-32000, "Origin not allowed"));
  };
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed"));
};

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json(jsonRpcError(-32000, "Not found"));
};

/**
 * Handles body parser failures (invalid JSON, oversized payloads) without
 * exposing stack traces, and logs everything else as an internal error.
 */
const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json(jsonRpcError(-32600, "Request body too large"));
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json(jsonRpcError(-32700, "Parse error"));
    return;
  }
  if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) {
    res.status(err.status).json(jsonRpcError(-32600, "Invalid request"));
    return;
  }
  console.error("Unhandled HTTP error:", err);
  res.status(500).json(jsonRpcError(-32603, "Internal server error"));
};

/**
 * Builds the Express app for the Streamable HTTP transport.
 *
 * The server runs in stateless mode: every POST gets a fresh MCP server and
 * transport, so no session state is kept between requests and the service can
 * be restarted or scaled without session affinity. Responses are plain JSON
 * instead of SSE streams, because no tool emits notifications.
 */
export function createHttpApp(config: HttpConfig, createMcpServer: () => McpServer): Express {
  const app = express();
  app.disable("x-powered-by");

  // Requests that can never be answered during shutdown are not processed at all (see listenHttp)
  app.use((req: TrackedRequest, _res, next) => {
    if (!req[UNANSWERABLE]) {
      next();
    }
  });

  // Liveness probe for container health checks; reveals nothing but "ok".
  // Registered before all checks so it works with any Host header.
  app.get(HEALTH_PATH, (_req, res) => {
    res.json({ status: "ok" });
  });

  if (config.allowedHosts.length > 0) {
    app.use(hostHeaderValidation(config.allowedHosts));
  }
  if (config.allowedOrigins.length > 0) {
    app.use(originValidation(config.allowedOrigins));
  }

  // Everything except the health check requires the token (fail closed). It
  // runs before body parsing so unauthenticated payloads are never buffered.
  app.use(requireStaticBearerToken(config.authToken));

  app.post(MCP_PATH, express.json({ limit: config.bodyLimit }), async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "Internal server error"));
      }
    }
  });

  // Stateless mode offers neither an SSE stream (GET) nor sessions (DELETE)
  app.all(MCP_PATH, methodNotAllowed);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

interface ConnectionTracking {
  sockets: Set<Socket>;
  /** Unfinished responses per socket in request order (more than one when pipelining). */
  pending: Map<Socket, ServerResponse[]>;
  /** Responses that were given "Connection: close". */
  announced: WeakSet<ServerResponse>;
  closing: boolean;
}

const connectionTracking = new WeakMap<HttpServer, ConnectionTracking>();

/** Marks requests that arrive on a connection whose close was already announced. */
const UNANSWERABLE = Symbol("unanswerable");

type TrackedRequest = IncomingMessage & { [UNANSWERABLE]?: boolean };

const LISTEN_ERROR_CODES = new Set(["EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Gives the last unfinished response of a connection "Connection: close", so
 * the client does not reuse a connection that is about to be closed. Only the
 * last one: Node closes the connection right after a response with that
 * header, so with pipelining any response behind it would be lost. Earlier
 * responses whose headers are not sent yet lose the header again.
 */
function announceClose(tracking: ConnectionTracking, responses: ServerResponse[]): void {
  responses.forEach((res, index) => {
    if (res.headersSent) {
      return;
    }
    if (index === responses.length - 1) {
      res.setHeader("Connection", "close");
      tracking.announced.add(res);
    } else if (tracking.announced.has(res)) {
      res.removeHeader("Connection");
      tracking.announced.delete(res);
    }
  });
}

/**
 * Starts listening and tracks connections for closeHttpServer().
 */
export async function listenHttp(app: Express, port: number, host: string): Promise<HttpServer> {
  // Express 5 invokes the listen callback with an error if binding fails
  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host, (error?: Error) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(
          code && LISTEN_ERROR_CODES.has(code)
            ? new ConfigError(`cannot listen on ${host}:${port} (${code}), check MCP_HTTP_HOST and MCP_HTTP_PORT`)
            : error
        );
        return;
      }
      resolve(server);
    });
  });
  httpServer.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;

  const tracking: ConnectionTracking = {
    sockets: new Set(),
    pending: new Map(),
    announced: new WeakSet(),
    closing: false,
  };
  connectionTracking.set(httpServer, tracking);

  httpServer.on("connection", (socket: Socket) => {
    tracking.sockets.add(socket);
    socket.once("close", () => {
      tracking.sockets.delete(socket);
      tracking.pending.delete(socket);
    });
  });

  // Registered before Express, which checks the UNANSWERABLE marker set here
  httpServer.prependListener("request", (req: TrackedRequest, res) => {
    const socket = req.socket;
    const responses = tracking.pending.get(socket) ?? [];
    if (tracking.closing && responses.some((earlier) => earlier.headersSent && tracking.announced.has(earlier))) {
      // The connection closes after that response, so this request could never be answered
      req[UNANSWERABLE] = true;
    }
    responses.push(res);
    tracking.pending.set(socket, responses);
    if (tracking.closing) {
      announceClose(tracking, responses);
    }
    res.once("close", () => {
      responses.splice(responses.indexOf(res), 1);
      if (responses.length > 0) {
        return;
      }
      tracking.pending.delete(socket);
      if (tracking.closing) {
        socket.destroySoon();
      }
    });
  });

  return httpServer;
}

/**
 * Stops accepting connections and resolves once all connections are closed.
 * Requires a server created by listenHttp().
 *
 * Every connection is ended with destroySoon(), which waits until buffered
 * response data has been written: idle ones right away, busy ones as soon as
 * their last unfinished response has finished. That response carries
 * "Connection: close" unless its headers were already sent; a client that
 * reuses such a connection afterwards sees it closed.
 *
 * http.Server#close() cannot be used here, because it calls
 * closeIdleConnections(), and Node already counts a connection as idle once
 * res.end() was called. That destroys connections whose response is still
 * being sent to a slow client and truncates the response, so only the
 * listening socket is closed via net.Server#close(). Node's internal
 * connection checking interval keeps running afterwards; it is unref'd and
 * does not keep the process alive.
 */
export function closeHttpServer(httpServer: HttpServer): Promise<void> {
  const tracking = connectionTracking.get(httpServer);
  if (!tracking) {
    return Promise.reject(new Error("closeHttpServer() requires a server started with listenHttp()"));
  }
  tracking.closing = true;
  for (const responses of tracking.pending.values()) {
    announceClose(tracking, responses);
  }

  return new Promise((resolve, reject) => {
    NetServer.prototype.close.call(httpServer, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    for (const socket of tracking.sockets) {
      if (!tracking.pending.has(socket)) {
        socket.destroySoon();
      }
    }
  });
}

/**
 * Starts the HTTP server and installs SIGTERM/SIGINT handlers for a graceful
 * shutdown (required when running as PID 1 in a container).
 */
export async function startHttpServer(
  config: HttpConfig,
  createMcpServer: () => McpServer
): Promise<HttpServer> {
  const app = createHttpApp(config, createMcpServer);
  const httpServer = await listenHttp(app, config.port, config.host);

  console.error(`sevdesk MCP server listening on http://${config.host}:${config.port}${MCP_PATH}`);
  console.error(
    config.allowedHosts.length > 0
      ? `Allowed Host headers: ${config.allowedHosts.join(", ")}`
      : "Host header validation is disabled (MCP_ALLOWED_HOSTS not set)"
  );
  console.error(
    config.allowedOrigins.length > 0
      ? `Allowed origins: ${config.allowedOrigins.join(", ")}`
      : "Origin validation is disabled (MCP_ALLOWED_ORIGINS not set)"
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    // A second signal (e.g. pressing Ctrl+C twice) skips waiting for open requests
    if (shuttingDown) {
      console.error(`Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.error(`Received ${signal}, shutting down`);
    const forceExit = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    closeHttpServer(httpServer).then(
      () => process.exit(0),
      (error) => {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    );
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return httpServer;
}
