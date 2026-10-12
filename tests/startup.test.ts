import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, connect } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTH_TOKEN = "k7Qp2Zr9Xw4Lm8Nc3Vb6Hy1Td5Fs0GaJ2uE7oR4iW9qP3sD6fK1lZ8xC5vB0nMt";

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
function spawnEntryPoint(env: Record<string, string>): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", SEVDESK_API_TOKEN: "dummy-sevdesk-token", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return { child, stderr: () => output };
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

async function startServer(): Promise<RunningServer> {
  const port = await freePort();
  const { child, stderr } = spawnEntryPoint({
    MCP_TRANSPORT: "http",
    MCP_AUTH_TOKEN: AUTH_TOKEN,
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
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
