import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "doco-mcp-server.mjs");

// Mirror the server's project-scoped state-file path so we can isolate
// the device-flow state between tests.
const PROJECT_HASH = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
const DEVICE_STATE_FILE = join(tmpdir(), `doco-mcp-device-${PROJECT_HASH}.json`);

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ExchangeOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface McpSession {
  send(message: JsonRpcMessage): void;
  readNext(timeoutMs?: number): Promise<JsonRpcMessage>;
  close(): Promise<void>;
}

// Spawn the MCP server, send a list of messages over stdin, collect
// `expectedResponses` newline-delimited JSON responses from stdout,
// then close stdin so the server's event loop drains and exits.
async function exchange(
  messages: JsonRpcMessage[],
  expectedResponses: number,
  opts: ExchangeOptions = {},
): Promise<JsonRpcMessage[]> {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd ?? process.cwd(),
    env,
  });

  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const responses: JsonRpcMessage[] = [];
  let buffer = "";
  let stdinClosed = false;

  const done = new Promise<JsonRpcMessage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort kill — server may already have exited.
      }
      reject(new Error(`MCP server timed out. stderr=${stderrText}`));
    }, opts.timeoutMs ?? 8000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line) as JsonRpcMessage);
          } catch (error) {
            clearTimeout(timer);
            reject(new Error(`Bad JSON from server: ${line} (${(error as Error).message})`));
            return;
          }
          if (responses.length >= expectedResponses && !stdinClosed) {
            stdinClosed = true;
            child.stdin.end();
          }
        }
        nl = buffer.indexOf("\n");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });

  for (const msg of messages) {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  if (expectedResponses === 0 && !stdinClosed) {
    stdinClosed = true;
    child.stdin.end();
  }

  return done;
}

function startMcpSession(opts: ExchangeOptions = {}): McpSession {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd ?? process.cwd(),
    env,
  });

  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const responses: JsonRpcMessage[] = [];
  const waiters: Array<{
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let buffer = "";
  let exited = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(line) as JsonRpcMessage;
        } catch (error) {
          const waiter = waiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`Bad JSON from server: ${line} (${(error as Error).message})`));
          }
          return;
        }
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        } else {
          responses.push(parsed);
        }
      }
      nl = buffer.indexOf("\n");
    }
  });

  child.on("exit", () => {
    exited = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited before response. stderr=${stderrText}`));
    }
  });

  return {
    send(message: JsonRpcMessage) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    readNext(timeoutMs = opts.timeoutMs ?? 8000) {
      const ready = responses.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best effort.
          }
          reject(new Error(`MCP server timed out. stderr=${stderrText}`));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    async close() {
      if (exited) return;
      if (!child.killed) child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
    },
  };
}

const INIT_MESSAGE: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  },
};

const INITIALIZED_NOTIFICATION: JsonRpcMessage = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
};

function clearDeviceState() {
  if (existsSync(DEVICE_STATE_FILE)) {
    try {
      unlinkSync(DEVICE_STATE_FILE);
    } catch {
      // Best effort.
    }
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

describe("doco-mcp-server", () => {
  beforeEach(() => {
    clearDeviceState();
  });
  afterEach(() => {
    clearDeviceState();
  });

  it("returns initialize result with capabilities, serverInfo, and instructions", async () => {
    const [init] = await exchange([INIT_MESSAGE], 1);
    expect(init.jsonrpc).toBe("2.0");
    expect(init.id).toBe(1);
    const result = init.result as {
      protocolVersion: string;
      capabilities: { tools?: object };
      serverInfo: { name: string; version: string };
      instructions: string;
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("doco");
    expect(result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.instructions).toContain("doco_search");
    expect(result.instructions).toContain("doco_capture");
    expect(result.instructions).toContain("doco_relate");
    expect(result.instructions).toContain("doco_authenticate");
    expect(result.instructions).toContain("doco_complete_authentication");
    expect(result.instructions).toContain("same local repository");
    expect(result.instructions).toContain("retry doco_search before");
    expect(result.instructions).toContain("DOCO_REFRESH");
    expect(result.instructions).toContain("asking the user to approve again");
  });

  it("advertises doco_search, doco_authenticate, and doco_complete_authentication via tools/list", async () => {
    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      2,
    );
    const listResp = responses.find((r) => r.id === 2);
    expect(listResp).toBeDefined();
    const tools = (
      listResp?.result as {
        tools: Array<{ name: string; description: string; inputSchema: { required?: string[] } }>;
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "doco_search",
      "doco_get",
      "doco_capture",
      "doco_relate",
      "doco_changeset",
      "doco_authenticate",
      "doco_complete_authentication",
    ]);
    const search = tools.find((t) => t.name === "doco_search");
    expect(search?.description).toMatch(/CALL THIS BEFORE/);
    expect(search?.description).toMatch(/DOCO_REFRESH/);
    expect(search?.inputSchema.required).toContain("query");
    const capture = tools.find((t) => t.name === "doco_capture");
    expect(capture?.description).toMatch(/write/i);
    expect(capture?.inputSchema.required).toEqual(["type", "body"]);
    const relate = tools.find((t) => t.name === "doco_relate");
    expect(relate?.inputSchema.required).toEqual(["edge_type", "from_id", "to_id"]);
    const get = tools.find((t) => t.name === "doco_get");
    expect(get?.inputSchema.required).toEqual(["resource"]);
    const changeset = tools.find((t) => t.name === "doco_changeset");
    expect(changeset?.inputSchema.required).toEqual(["operations"]);
    const authenticate = tools.find((t) => t.name === "doco_authenticate");
    expect(authenticate?.description).toMatch(/device-flow/);
    expect(authenticate?.description).toMatch(/shared/);
    const complete = tools.find((t) => t.name === "doco_complete_authentication");
    expect(complete?.description).toMatch(/polls the token endpoint/);
    expect(complete?.description).toMatch(/any agent in this local/);
  });

  it("returns an MCP isError result when doco_search is called with an empty query", async () => {
    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "doco_search", arguments: { query: "  " } },
        },
      ],
      2,
    );
    const callResp = responses.find((r) => r.id === 2);
    const result = callResp?.result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty/);
  });

  it("returns JSON-RPC -32601 for unknown methods", async () => {
    const [resp] = await exchange(
      [{ jsonrpc: "2.0", id: 1, method: "frobnicate/widget", params: {} }],
      1,
    );
    expect(resp.error?.code).toBe(-32601);
  });

  it("returns JSON-RPC -32602 when tools/call references an unknown tool", async () => {
    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "doco_capture_decision", arguments: {} },
        },
      ],
      2,
    );
    const callResp = responses.find((r) => r.id === 2);
    expect(callResp?.error?.code).toBe(-32602);
  });

  it("responds to ping", async () => {
    const [resp] = await exchange([{ jsonrpc: "2.0", id: 1, method: "ping", params: {} }], 1);
    expect(resp.result).toEqual({});
  });

  it("returns empty arrays for resources/list and prompts/list (no-op surfaces)", async () => {
    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} },
      ],
      3,
    );
    const resourcesResp = responses.find((r) => r.id === 2);
    const promptsResp = responses.find((r) => r.id === 3);
    expect((resourcesResp?.result as { resources: unknown[] }).resources).toEqual([]);
    expect((promptsResp?.result as { prompts: unknown[] }).prompts).toEqual([]);
  });

  it("doco_complete_authentication returns isError when no device flow is in progress", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-no-device-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_complete_authentication", arguments: {} },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: {
            DOCO_DEVICE_CLIENT_ID: undefined,
            DOCO_DEVICE_CODE: undefined,
            DOCO_DEVICE_INTERVAL: undefined,
            DOCO_DEVICE_EXPIRES_AT: undefined,
            DOCO_DEVICE_TARGET_HANDLE: undefined,
            DOCO_DEVICE_REQUESTED_ROLE: undefined,
          },
        },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/no device-authorization flow in progress/i);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_complete_authentication returns isError when device code has expired", async () => {
    // Plant an expired state file.
    writeFileSync(
      DEVICE_STATE_FILE,
      JSON.stringify({
        client_id: "doco_client_test",
        device_code: "doco_dc_test",
        interval: 5,
        expires_at: Math.floor(Date.now() / 1000) - 60,
        target_doco_handle: "doco-bpms",
        requested_role: "reader",
      }),
      { mode: 0o600 },
    );

    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "doco_complete_authentication", arguments: {} },
        },
      ],
      2,
    );
    const callResp = responses.find((r) => r.id === 2);
    const result = callResp?.result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/expired/i);
    // The server should have cleared the state file.
    expect(existsSync(DEVICE_STATE_FILE)).toBe(false);
  });

  it("doco_complete_authentication recovers pending device state from .env", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-env-state-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    let tokenRequests = 0;
    const tokenServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/oauth/token") {
        tokenRequests += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "doco_at_env_state",
            refresh_token: "doco_rt_env_state",
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      tokenServer.listen(0, "127.0.0.1", resolve);
    });

    const address = tokenServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    writeFileSync(
      join(projectDir, ".env"),
      [
        `DOCO_HOST=${host}`,
        "DOCO_DEVICE_CLIENT_ID=doco_client_env_state",
        "DOCO_DEVICE_CODE=doco_dc_env_state",
        "DOCO_DEVICE_INTERVAL=1",
        `DOCO_DEVICE_EXPIRES_AT=${expiresAt}`,
        "DOCO_DEVICE_TARGET_HANDLE=doco-bpms",
        "DOCO_DEVICE_REQUESTED_ROLE=reader",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "doco_complete_authentication",
              arguments: { wait_seconds: 5 },
            },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: {
            DOCO_HOST: undefined,
            DOCO_ACCESS: undefined,
            DOCO_DEVICE_CLIENT_ID: undefined,
            DOCO_DEVICE_CODE: undefined,
            DOCO_DEVICE_INTERVAL: undefined,
            DOCO_DEVICE_EXPIRES_AT: undefined,
            DOCO_DEVICE_TARGET_HANDLE: undefined,
            DOCO_DEVICE_REQUESTED_ROLE: undefined,
          },
          timeoutMs: 10000,
        },
      );

      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Authenticated/);
      expect(tokenRequests).toBe(1);

      const envText = readFileSync(join(projectDir, ".env"), "utf8");
      expect(envText).toContain("DOCO_ACCESS=doco_at_env_state");
      expect(envText).toContain("DOCO_REFRESH=doco_rt_env_state");
      expect(envText).toContain("DOCO_CLIENT_ID=doco_client_env_state");
      expect(envText).not.toContain("DOCO_DEVICE_CODE=");
      expect(envText).not.toContain("DOCO_DEVICE_EXPIRES_AT=");
    } finally {
      await new Promise<void>((resolve) => {
        tokenServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search prefers the shared repo .env credential over inherited process env", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-env-precedence-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    const seenAuth: string[] = [];
    const searchServer = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_file_token", ""].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "credential precedence" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: {
            DOCO_HOST: undefined,
            DOCO_ACCESS: "doco_at_stale_inherited_token",
          },
        },
      );

      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(seenAuth).toEqual(["Bearer doco_at_file_token"]);
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search refreshes from DOCO_REFRESH when DOCO_ACCESS is missing", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-refresh-missing-access-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    const tokenRequests: Array<Record<string, string>> = [];
    const seenAuth: string[] = [];
    const searchServer = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/oauth/token") {
        tokenRequests.push(Object.fromEntries(new URLSearchParams(await readRequestBody(req))));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "doco_at_refreshed_access",
            refresh_token: "doco_rt_rotated_refresh",
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [
        `DOCO_HOST=${host}`,
        "DOCO_REFRESH=doco_rt_existing_refresh",
        "DOCO_CLIENT_ID=doco_client_existing",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "refresh missing access" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: {
            DOCO_HOST: undefined,
            DOCO_ACCESS: undefined,
            DOCO_REFRESH: undefined,
            DOCO_CLIENT_ID: undefined,
          },
        },
      );

      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(tokenRequests).toEqual([
        {
          grant_type: "refresh_token",
          refresh_token: "doco_rt_existing_refresh",
          client_id: "doco_client_existing",
        },
      ]);
      expect(seenAuth).toEqual(["Bearer doco_at_refreshed_access"]);

      const envText = readFileSync(join(projectDir, ".env"), "utf8");
      expect(envText).toContain("DOCO_ACCESS=doco_at_refreshed_access");
      expect(envText).toContain("DOCO_REFRESH=doco_rt_rotated_refresh");
      expect(envText).toContain("DOCO_CLIENT_ID=doco_client_existing");
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search refreshes and retries after stale DOCO_ACCESS returns 401", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-refresh-stale-access-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    const tokenRequests: Array<Record<string, string>> = [];
    const seenAuth: string[] = [];
    const searchServer = createServer(async (req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        if (seenAuth.length === 1) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/oauth/token") {
        tokenRequests.push(Object.fromEntries(new URLSearchParams(await readRequestBody(req))));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "doco_at_retry_access",
            refresh_token: "doco_rt_retry_refresh",
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [
        `DOCO_HOST=${host}`,
        "DOCO_ACCESS=doco_at_stale_access",
        "DOCO_REFRESH=doco_rt_stale_refresh",
        "DOCO_CLIENT_ID=doco_client_stale",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "refresh stale access" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: {
            DOCO_HOST: undefined,
            DOCO_ACCESS: undefined,
            DOCO_REFRESH: undefined,
            DOCO_CLIENT_ID: undefined,
          },
        },
      );

      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(tokenRequests).toEqual([
        {
          grant_type: "refresh_token",
          refresh_token: "doco_rt_stale_refresh",
          client_id: "doco_client_stale",
        },
      ]);
      expect(seenAuth).toEqual(["Bearer doco_at_stale_access", "Bearer doco_at_retry_access"]);

      const envText = readFileSync(join(projectDir, ".env"), "utf8");
      expect(envText).toContain("DOCO_ACCESS=doco_at_retry_access");
      expect(envText).toContain("DOCO_REFRESH=doco_rt_retry_refresh");
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search rereads .env so one agent can see another agent's fresh token", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-env-refresh-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    const seenAuth: string[] = [];
    let host = "";
    const searchServer = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        if (seenAuth.length === 1) {
          writeFileSync(
            join(projectDir, ".env"),
            [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_fresh_token", ""].join("\n"),
            { mode: 0o600 },
          );
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_initial_token", ""].join("\n"),
      { mode: 0o600 },
    );

    const session = startMcpSession({
      cwd: projectDir,
      env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined },
      timeoutMs: 10000,
    });

    try {
      session.send(INIT_MESSAGE);
      await session.readNext();
      session.send(INITIALIZED_NOTIFICATION);
      session.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "doco_search", arguments: { query: "first search" } },
      });
      await session.readNext();
      session.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "doco_search", arguments: { query: "second search" } },
      });
      const second = await session.readNext();
      const result = second.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(seenAuth).toEqual(["Bearer doco_at_initial_token", "Bearer doco_at_fresh_token"]);
    } finally {
      await session.close();
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search falls back to .doco/project-tokens.json when no DOCO_ACCESS is set", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-pt-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");
    writeFileSync(
      join(docoDir, "project-tokens.json"),
      JSON.stringify({ "doco-bpms": "doco_pt_committed_test_token" }, null, 2),
    );

    const seenAuth: string[] = [];
    const searchServer = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    // Crucially: no .env in the project dir, and no DOCO_ACCESS in
    // the inherited environment. The project token is the ONLY source.
    writeFileSync(join(projectDir, ".env"), `DOCO_HOST=${host}\n`, { mode: 0o600 });

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "any query" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined },
        },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(seenAuth).toEqual(["Bearer doco_pt_committed_test_token"]);
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search tells agents to use the credential-aware indicator prefix", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-indicator-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    const searchServer = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            count: 0,
            duration_ms: 8,
            hits: [],
            viewer: {
              username: "torrenegra",
              type: "person",
              credential: {
                nickname: "Nightly Doco Runner",
                on_behalf_of_username: "torrenegra",
                indicator_prefix: "[🔮 Doco Nightly Doco Runner on behalf of @torrenegra]",
              },
              indicator_prefix: "[🔮 Doco Nightly Doco Runner on behalf of @torrenegra]",
            },
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_personal_oauth_token", ""].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "indicator prefix" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined },
        },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(
        "Prefix Doco indicator lines this turn with [🔮 Doco Nightly Doco Runner on behalf of @torrenegra].",
      );
      expect(result.content[0].text).not.toContain("[🔮 Doco @torrenegra]");
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search prefers .env DOCO_ACCESS over a committed project token", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-pt-precedence-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");
    writeFileSync(
      join(docoDir, "project-tokens.json"),
      JSON.stringify({ "doco-bpms": "doco_pt_committed_token" }, null, 2),
    );

    const seenAuth: string[] = [];
    const searchServer = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    // .env has DOCO_ACCESS — it must win over the committed project token.
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_personal_oauth_token", ""].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "any query" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined },
        },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(seenAuth).toEqual(["Bearer doco_at_personal_oauth_token"]);
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_search ignores .doco/project-tokens.json entries with the wrong prefix", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-pt-bad-prefix-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");
    // A token without the doco_pt_ prefix must NOT be used — that
    // would expose the user to accidentally pasting their personal
    // OAuth token into a committed file.
    writeFileSync(
      join(docoDir, "project-tokens.json"),
      JSON.stringify({ "doco-bpms": "doco_at_personal_token_in_wrong_place" }, null, 2),
    );

    const seenAuth: string[] = [];
    const searchServer = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/doco-bpms/search.json")) {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, duration_ms: 1, hits: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      searchServer.listen(0, "127.0.0.1", resolve);
    });

    const address = searchServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(join(projectDir, ".env"), `DOCO_HOST=${host}\n`, { mode: 0o600 });

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "any query" } },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined },
        },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      // No DOCO_ACCESS could be resolved → search hits the server
      // anonymously, and the test server returns the same 200 either
      // way. The important assertion is that the wrong-prefix token
      // was NOT sent as the Bearer.
      expect(result.isError).toBeFalsy();
      expect(seenAuth).toEqual([""]);
    } finally {
      await new Promise<void>((resolve) => {
        searchServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_complete_authentication's success message includes the persist-credentials hint", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-success-hint-"));
    const docoDir = join(projectDir, ".doco");
    mkdirSync(docoDir);
    writeFileSync(join(docoDir, "connections.md"), "https://doco.to/doco-bpms/\n");

    const tokenServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/oauth/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "doco_at_hint_check",
            refresh_token: "doco_rt_hint_check",
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      tokenServer.listen(0, "127.0.0.1", resolve);
    });

    const address = tokenServer.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    writeFileSync(
      join(projectDir, ".env"),
      [
        `DOCO_HOST=${host}`,
        "DOCO_DEVICE_CLIENT_ID=doco_client_hint_check",
        "DOCO_DEVICE_CODE=doco_dc_hint_check",
        "DOCO_DEVICE_INTERVAL=1",
        `DOCO_DEVICE_EXPIRES_AT=${expiresAt}`,
        "DOCO_DEVICE_TARGET_HANDLE=doco-bpms",
        "DOCO_DEVICE_REQUESTED_ROLE=reader",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "doco_complete_authentication",
              arguments: { wait_seconds: 5 },
            },
          },
        ],
        2,
        {
          cwd: projectDir,
          env: {
            DOCO_HOST: undefined,
            DOCO_ACCESS: undefined,
            DOCO_DEVICE_CLIENT_ID: undefined,
            DOCO_DEVICE_CODE: undefined,
            DOCO_DEVICE_INTERVAL: undefined,
            DOCO_DEVICE_EXPIRES_AT: undefined,
            DOCO_DEVICE_TARGET_HANDLE: undefined,
            DOCO_DEVICE_REQUESTED_ROLE: undefined,
          },
          timeoutMs: 10000,
        },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toMatch(/Authenticated/);
      // The two persistence options must both be surfaced.
      expect(text).toMatch(/DOCO_ACCESS as a persistent environment variable/i);
      expect(text).toMatch(/project token/i);
      expect(text).toMatch(/project-tokens/);
      // The agent must be told to surface this only once, not on every turn.
      expect(text).toMatch(/once/i);
    } finally {
      await new Promise<void>((resolve) => {
        tokenServer.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.DOCO_ACCESS)(
    "doco_search returns hits (or a clean empty-result message) when DOCO_ACCESS is available",
    async () => {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_search", arguments: { query: "doco protocol", limit: 3 } },
          },
        ],
        2,
        { timeoutMs: 15000 },
      );
      const callResp = responses.find((r) => r.id === 2);
      const result = callResp?.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Found \d+ nodes? in Doco|No matches in Doco/);
    },
    20000,
  );

  it("doco_capture POSTs the body to the plural per-type route and renders id + footer_lines", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-capture-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");

    const seen: Array<{ auth: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      // singular "decision" must be normalized to the plural route:
      if (req.method === "POST" && req.url === "/doco-bpms/api/decisions.json") {
        seen.push({
          auth: String(req.headers.authorization || ""),
          body: await readRequestBody(req),
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            id: "decision_abc",
            footer_lines: ["[🔮 Doco] ✍️ Decision added"],
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_writer", ""].join("\n"),
      {
        mode: 0o600,
      },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "doco_capture",
              arguments: { type: "decision", body: { decision: "X", question: "Y?" } },
            },
          },
        ],
        2,
        { cwd: projectDir, env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined } },
      );
      const result = responses.find((r) => r.id === 2)?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("decision_abc");
      expect(result.content[0].text).toContain("Decision added");
      expect(seen).toHaveLength(1);
      expect(seen[0].auth).toBe("Bearer doco_at_writer");
      expect(JSON.parse(seen[0].body)).toEqual({ decision: "X", question: "Y?" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_capture surfaces a 403 as a writer step-up hint", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-capture-403-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");
    const server = createServer((req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_reader", ""].join("\n"),
      {
        mode: 0o600,
      },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "doco_capture",
              arguments: { type: "decisions", body: { decision: "x" } },
            },
          },
        ],
        2,
        { cwd: projectDir, env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined } },
      );
      const result = responses.find((r) => r.id === 2)?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/403/);
      expect(result.content[0].text).toMatch(/requested_role='writer'/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_relate POSTs the edge to the edges route", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-relate-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");
    let body = "";
    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/doco-bpms/api/edges.json") {
        body = await readRequestBody(req);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "edge_xyz" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_writer", ""].join("\n"),
      {
        mode: 0o600,
      },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "doco_relate",
              arguments: { edge_type: "supports", from_id: "decision_1", to_id: "intent_1" },
            },
          },
        ],
        2,
        { cwd: projectDir, env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined } },
      );
      const result = responses.find((r) => r.id === 2)?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("edge_xyz");
      expect(JSON.parse(body)).toEqual({
        edge_type: "supports",
        from_id: "decision_1",
        to_id: "intent_1",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_capture returns isError when the body is missing", async () => {
    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "doco_capture", arguments: { type: "decisions" } },
        },
      ],
      2,
    );
    const result = responses.find((r) => r.id === 2)?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/body/);
  });

  it("doco_changeset POSTs operations to the changesets route and renders the result", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-changeset-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");
    const seen: Array<{ auth: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/doco-bpms/api/changesets.json") {
        seen.push({
          auth: String(req.headers.authorization || ""),
          body: await readRequestBody(req),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            results: [{ op_index: 0, op: "create", ok: true, id: "action_xyz" }],
            aliases: { start: "action_xyz" },
            footer_lines: ["[🔮 Doco] ✍️ 1 node created"],
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_writer", ""].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "doco_changeset",
              arguments: {
                operations: [
                  {
                    op: "create",
                    entity_type: "action",
                    alias: "start",
                    body: { action: "Begin" },
                  },
                ],
                validate_against: "process",
              },
            },
          },
        ],
        2,
        { cwd: projectDir, env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined } },
      );
      const result = responses.find((r) => r.id === 2)?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("action_xyz");
      expect(seen).toHaveLength(1);
      expect(seen[0].auth).toBe("Bearer doco_at_writer");
      expect(JSON.parse(seen[0].body)).toEqual({
        operations: [
          { op: "create", entity_type: "action", alias: "start", body: { action: "Begin" } },
        ],
        validate_against: "process",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_get reads a path under the doco and renders the JSON body", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-mcp-get-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");
    const seenAuth: string[] = [];
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/doco-bpms/api/policies.json") {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, policies: [{ id: "policy_1", rule: "capture decisions" }] }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [`DOCO_HOST=${host}`, "DOCO_ACCESS=doco_at_reader", ""].join("\n"),
      { mode: 0o600 },
    );

    try {
      const responses = await exchange(
        [
          INIT_MESSAGE,
          INITIALIZED_NOTIFICATION,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "doco_get", arguments: { resource: "api/policies.json" } },
          },
        ],
        2,
        { cwd: projectDir, env: { DOCO_HOST: undefined, DOCO_ACCESS: undefined } },
      );
      const result = responses.find((r) => r.id === 2)?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("capture decisions");
      expect(seenAuth).toEqual(["Bearer doco_at_reader"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("doco_get rejects a resource outside the doco read surface without a request", async () => {
    const responses = await exchange(
      [
        INIT_MESSAGE,
        INITIALIZED_NOTIFICATION,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "doco_get", arguments: { resource: "../../secret" } },
        },
      ],
      2,
    );
    const result = responses.find((r) => r.id === 2)?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
  });
});
