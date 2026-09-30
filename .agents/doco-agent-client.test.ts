import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(__dirname, "doco-agent-client.mjs");

interface ClientRunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

async function runClient(args: string[], opts: ClientRunOptions) {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const child = spawn("node", [CLIENT_PATH, ...args], {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent client timed out. stderr=${stderr}`));
    }, 8000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
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

describe("doco-agent-client", () => {
  it("bootstrap refreshes from DOCO_REFRESH when DOCO_ACCESS is missing", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-agent-client-bootstrap-refresh-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");

    const tokenRequests: Array<Record<string, string>> = [];
    const seenAuth: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/oauth/token") {
        tokenRequests.push(Object.fromEntries(new URLSearchParams(await readRequestBody(req))));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "doco_at_client_bootstrap",
            refresh_token: "doco_rt_client_bootstrap_rotated",
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/v1/agent-bootstrap.json") {
        seenAuth.push(String(req.headers.authorization || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agent_instructions: "ok" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [
        `DOCO_HOST=${host}`,
        "DOCO_REFRESH=doco_rt_client_bootstrap",
        "DOCO_CLIENT_ID=doco_client_bootstrap",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const result = await runClient(["bootstrap", "--meta"], {
        cwd: projectDir,
        env: {
          DOCO_HOST: undefined,
          DOCO_ACCESS: undefined,
          DOCO_REFRESH: undefined,
          DOCO_CLIENT_ID: undefined,
        },
      });
      expect(result.code).toBe(0);
      const meta = JSON.parse(result.stdout);
      expect(meta.ok).toBe(true);
      expect(meta.refreshed).toBe(true);
      expect(tokenRequests).toEqual([
        {
          grant_type: "refresh_token",
          refresh_token: "doco_rt_client_bootstrap",
          client_id: "doco_client_bootstrap",
        },
      ]);
      expect(seenAuth).toEqual(["Bearer doco_at_client_bootstrap"]);

      const envText = readFileSync(join(projectDir, ".env"), "utf8");
      expect(envText).toContain("DOCO_ACCESS=doco_at_client_bootstrap");
      expect(envText).toContain("DOCO_REFRESH=doco_rt_client_bootstrap_rotated");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("search refreshes and retries when stale DOCO_ACCESS returns 401", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doco-agent-client-search-refresh-"));
    mkdirSync(join(projectDir, ".doco"));
    writeFileSync(join(projectDir, ".doco", "connections.md"), "https://doco.to/doco-bpms/\n");

    const tokenRequests: Array<Record<string, string>> = [];
    const seenAuth: string[] = [];
    const server = createServer(async (req, res) => {
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
            access_token: "doco_at_client_search",
            refresh_token: "doco_rt_client_search_rotated",
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const host = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      join(projectDir, ".env"),
      [
        `DOCO_HOST=${host}`,
        "DOCO_ACCESS=doco_at_client_stale",
        "DOCO_REFRESH=doco_rt_client_search",
        "DOCO_CLIENT_ID=doco_client_search",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const result = await runClient(["search", "--q", "refresh test", "--meta"], {
        cwd: projectDir,
        env: {
          DOCO_HOST: undefined,
          DOCO_ACCESS: undefined,
          DOCO_REFRESH: undefined,
          DOCO_CLIENT_ID: undefined,
        },
      });
      expect(result.code).toBe(0);
      const meta = JSON.parse(result.stdout);
      expect(meta.ok).toBe(true);
      expect(meta.refreshed).toBe(true);
      expect(tokenRequests).toEqual([
        {
          grant_type: "refresh_token",
          refresh_token: "doco_rt_client_search",
          client_id: "doco_client_search",
        },
      ]);
      expect(seenAuth).toEqual(["Bearer doco_at_client_stale", "Bearer doco_at_client_search"]);

      const envText = readFileSync(join(projectDir, ".env"), "utf8");
      expect(envText).toContain("DOCO_ACCESS=doco_at_client_search");
      expect(envText).toContain("DOCO_REFRESH=doco_rt_client_search_rotated");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
