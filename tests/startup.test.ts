import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, connect } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTH_TOKEN = "k7Qp2Zr9Xw4Lm8Nc3Vb6Hy1Td5Fs0GaJ2uE7oR4iW9qP3sD6fK1lZ8xC5vB0nMt"; // gitleaks:allow (synthetic test token)

interface RunningServer {
  child: ChildProcess;
  port: number;
  stderr: () => string;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Runs the real entry point in a child process, so signal handling does not affect the test runner
function spawnEntryPoint(env: Record<string, string>): {
  child: ChildProcess;
  stderr: () => string;
  stdout: () => string;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", SEVDESK_API_TOKEN: "dummy-sevdesk-token", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let stdoutOutput = "";
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stdout?.on("data", (chunk: Buffer) => (stdoutOutput += chunk.toString()));
  return { child, stderr: () => output, stdout: () => stdoutOutput };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const { child, stderr } = spawnEntryPoint({
    MCP_TRANSPORT: "http",
    MCP_AUTH_TOKEN: AUTH_TOKEN,
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    ...extraEnv,
  });
  const deadline = Date.now() + 15_000;
  while (!stderr().includes("listening on")) {
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`Server did not start: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, port, stderr };
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { code, signal };
}

// Request whose body never completes: counts as a running request until shutdown gives up
async function openStalledRequest(port: number) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.on("error", () => undefined);
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${AUTH_TOKEN}\r\n` +
      "Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  return socket;
}

describe("startHttpServer (Kindprozess)", () => {
  it("sollte starten, Keep-Alive passend zu Traefik setzen und bei SIGTERM sauber enden", async () => {
    const { child, port, stderr } = await startServer();

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("keep-alive")).toBe("timeout=95");

    child.kill("SIGTERM");
    expect(await exitOf(child)).toEqual({ code: 0, signal: null });
    expect(stderr()).toContain("Received SIGTERM, shutting down");
  });

  it("sollte auch bei SIGINT sauber enden", async () => {
    const { child, stderr } = await startServer();
    child.kill("SIGINT");
    expect(await exitOf(child)).toEqual({ code: 0, signal: null });
    expect(stderr()).toContain("Received SIGINT, shutting down");
  });

  it("sollte bei einem zweiten Signal sofort abbrechen", async () => {
    const { child, port, stderr } = await startServer();
    const socket = await openStalledRequest(port);

    child.kill("SIGTERM");
    await waitFor(() => stderr().includes("shutting down"));
    const started = Date.now();
    // Same signal twice: also verifies the handler stays installed after the first one
    child.kill("SIGTERM");
    expect(await exitOf(child)).toEqual({ code: 1, signal: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stderr()).toContain("Received SIGTERM again, forcing exit");
    socket.destroy();
  });

  it("sollte hängende Anfragen nach dem Shutdown-Timeout abbrechen", async () => {
    const { child, port, stderr } = await startServer();
    const socket = await openStalledRequest(port);

    const started = Date.now();
    child.kill("SIGTERM");
    expect(await exitOf(child)).toEqual({ code: 1, signal: null });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(15_000);
    expect(stderr()).toContain("Shutdown timed out, forcing exit");
    socket.destroy();
  }, 30_000);

  it("sollte bei fehlender Konfiguration mit Exit-Code 1 und klarer Meldung enden", async () => {
    const { child, stderr } = spawnEntryPoint({ MCP_TRANSPORT: "http" });
    expect(await exitOf(child)).toEqual({ code: 1, signal: null });
    expect(stderr()).toContain("Configuration error: MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http");
    expect(stderr()).not.toContain("    at ");
  });
});

describe("MCP_READ_ONLY (Kindprozess)", () => {
  async function listToolsOverHttp(port: number): Promise<string[]> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await res.json();
    return body.result.tools.map((tool: { name: string }) => tool.name);
  }

  it("sollte über HTTP nur lesende Tools anbieten", async () => {
    const { child, port, stderr } = await startServer({ MCP_READ_ONLY: "true" });
    const tools = await listToolsOverHttp(port);
    expect(tools).toHaveLength(19);
    expect(tools).not.toContain("delete_contact");
    expect(stderr()).toContain("Read-only mode: only read-only tools are available");
    child.kill("SIGTERM");
    await exitOf(child);
  });

  it("sollte ohne MCP_READ_ONLY alle Tools anbieten und das melden", async () => {
    const { child, port, stderr } = await startServer();
    expect(await listToolsOverHttp(port)).toHaveLength(34);
    expect(stderr()).toContain("All tools are available, including those that change data");
    child.kill("SIGTERM");
    await exitOf(child);
  });

  async function listToolsOverStdio(env: Record<string, string>): Promise<number> {
    const { child, stdout } = spawnEntryPoint(env);
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    child.stdin?.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    await waitFor(() => stdout().includes('"id":2'));
    const response = stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);
    child.stdin?.end();
    child.kill("SIGTERM");
    await exitOf(child);
    return response.result.tools.length;
  }

  it("sollte über stdio nur lesende Tools anbieten", async () => {
    expect(await listToolsOverStdio({ MCP_READ_ONLY: "1" })).toBe(19);
  });

  it("sollte über stdio ohne MCP_READ_ONLY alle Tools anbieten", async () => {
    expect(await listToolsOverStdio({})).toBe(34);
  });

  it("sollte ungültige Werte mit Exit-Code 1 ablehnen", async () => {
    const { child, stderr } = spawnEntryPoint({
      MCP_TRANSPORT: "http",
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      MCP_READ_ONLY: "yes",
    });
    expect(await exitOf(child)).toEqual({ code: 1, signal: null });
    expect(stderr()).toContain('Configuration error: MCP_READ_ONLY must be true or false, got "yes"');
  });
});
