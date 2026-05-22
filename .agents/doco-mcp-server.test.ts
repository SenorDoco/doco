import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
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

// Spawn the MCP server, send a list of messages over stdin, collect
// `expectedResponses` newline-delimited JSON responses from stdout,
// then close stdin so the server's event loop drains and exits.
async function exchange(
  messages: JsonRpcMessage[],
  expectedResponses: number,
  opts: ExchangeOptions = {},
): Promise<JsonRpcMessage[]> {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
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
    expect(result.instructions).toContain("doco_authenticate");
    expect(result.instructions).toContain("doco_complete_authentication");
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
    const tools = (listResp?.result as { tools: Array<{ name: string; description: string; inputSchema: { required?: string[] } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["doco_search", "doco_authenticate", "doco_complete_authentication"]);
    const search = tools.find((t) => t.name === "doco_search");
    expect(search?.description).toMatch(/CALL THIS BEFORE/);
    expect(search?.inputSchema.required).toContain("query");
    const authenticate = tools.find((t) => t.name === "doco_authenticate");
    expect(authenticate?.description).toMatch(/device-flow/);
    const complete = tools.find((t) => t.name === "doco_complete_authentication");
    expect(complete?.description).toMatch(/polls the token endpoint/);
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
    const result = callResp?.result as { isError: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty/);
  });

  it("returns JSON-RPC -32601 for unknown methods", async () => {
    const [resp] = await exchange([{ jsonrpc: "2.0", id: 1, method: "frobnicate/widget", params: {} }], 1);
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
    const result = callResp?.result as { isError: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no device-authorization flow in progress/i);
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
    const result = callResp?.result as { isError: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/expired/i);
    // The server should have cleared the state file.
    expect(existsSync(DEVICE_STATE_FILE)).toBe(false);
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
      const result = callResp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Found \d+ nodes? in Doco|No matches in Doco/);
    },
    20000,
  );
});
