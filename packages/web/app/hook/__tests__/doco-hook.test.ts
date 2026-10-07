// The Doco hook as the clients run it: a process fed one event on stdin that
// prints the brief as additionalContext, or nothing. The brief route is a
// local stub that records what the hook asked for.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOCO_REMINDER } from "../../lib/agent-instructions";
import { DOCO_REMINDER as HOOK_REMINDER, requestFor, resolveConfig } from "../doco-hook.mjs";

const HOOK = new URL("../doco-hook.mjs", import.meta.url).pathname;

let server: Server;
let origin: string;
const requests: { url: string; authorization: string | undefined }[] = [];
let respond: (url: URL) => { status: number; body: string; delayMs?: number } = () => ({
  status: 200,
  body: "Doco brief brief_1 · about: x\n\n## Must obey\n- rule_1",
});

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    const { status, body, delayMs } = respond(new URL(req.url ?? "/", "http://x"));
    setTimeout(() => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    }, delayMs ?? 0);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  requests.length = 0;
});

function runHook(
  event: Record<string, unknown>,
  env: Record<string, string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => done({ stdout, stderr, code }));
    child.stdin.end(JSON.stringify(event));
  });
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "doco-hook-"));
  mkdirSync(join(dir, "packages", "web"), { recursive: true });
  return dir;
}

const session = () => `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;

describe("the Doco hook", () => {
  it("carries the reminder line the instructions name", () => {
    expect(HOOK_REMINDER).toBe(DOCO_REMINDER);
  });

  it("briefs a prompt, reminder first, for Claude Code and Codex (UserPromptSubmit) and Gemini CLI (BeforeAgent)", async () => {
    const cwd = project();
    for (const name of ["UserPromptSubmit", "BeforeAgent"]) {
      const out = await runHook(
        { hook_event_name: name, session_id: session(), cwd, prompt: "add a brief route" },
        { DOCO_ORIGIN: origin, DOCO_TOKEN: "doco_pt_env", DOCO_WORKSPACE: "acme" },
        cwd,
      );
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: name,
          additionalContext: `${DOCO_REMINDER}\n\nDoco brief brief_1 · about: x\n\n## Must obey\n- rule_1`,
        },
      });
    }
    expect(requests.map((r) => r.url)).toEqual([
      "/api/v1/brief.json?workspace=acme&format=text&about=add+a+brief+route&budget=4000",
      "/api/v1/brief.json?workspace=acme&format=text&about=add+a+brief+route&budget=4000",
    ]);
    expect(requests[0].authorization).toBe("Bearer doco_pt_env");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("briefs the file an edit touches, once per session and file, without the synthesis", async () => {
    const cwd = project();
    const id = session();
    const event = {
      hook_event_name: "PreToolUse",
      session_id: id,
      cwd,
      tool_name: "Edit",
      tool_input: { file_path: join(cwd, "packages/web/app/lib/search.server.ts") },
    };
    const env = { DOCO_ORIGIN: origin, DOCO_TOKEN: "doco_pt_env", DOCO_WORKSPACE: "acme" };
    const first = await runHook(event, env, cwd);
    expect(JSON.parse(first.stdout).hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: "Doco brief brief_1 · about: x\n\n## Must obey\n- rule_1",
    });
    expect(requests.map((r) => r.url)).toEqual([
      "/api/v1/brief.json?workspace=acme&format=text&touching=packages%2Fweb%2Fapp%2Flib%2Fsearch.server.ts&budget=1500&synthesize=0",
    ]);
    const again = await runHook(event, env, cwd);
    expect(again.stdout).toBe("");
    expect(requests).toHaveLength(1);
    const other = await runHook(
      { ...event, tool_input: { file_path: "/elsewhere/notes.md" } },
      env,
      cwd,
    );
    expect(JSON.parse(other.stdout).hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(requests[1].url).toContain("touching=%2Felsewhere%2Fnotes.md");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("loads the standing orders at session start, with what changed since the last start here", async () => {
    const cwd = project();
    const env = { DOCO_ORIGIN: origin, DOCO_TOKEN: "doco_pt_env", DOCO_WORKSPACE: "acme" };
    const orders = "Standing orders for Acme (acme)\n\n## Constitution\nShip small.";
    respond = () => ({ status: 200, body: orders });
    const event = {
      hook_event_name: "SessionStart",
      session_id: session(),
      cwd,
      source: "startup",
    };
    const first = await runHook(event, env, cwd);
    expect(JSON.parse(first.stdout).hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: orders,
    });
    expect(requests.map((r) => r.url)).toEqual([
      "/api/v1/standing-orders.json?workspace=acme&format=text",
    ]);
    const second = await runHook({ ...event, session_id: session() }, env, cwd);
    expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toBe(orders);
    const since = new URL(requests[1].url, "http://x").searchParams.get("since");
    expect(Math.abs(Date.now() - Date.parse(since ?? ""))).toBeLessThan(60_000);
    respond = () => ({
      status: 200,
      body: "Doco brief brief_1 · about: x\n\n## Must obey\n- rule_1",
    });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads the workspace, the origin and the token from the project's files", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `# Project\n\n<!-- doco:begin v1 -->\n...\n<!-- doco:end -->\nDoco workspace: ${origin}/workspaces/acme\n`,
    );
    mkdirSync(join(cwd, ".doco"));
    writeFileSync(
      join(cwd, ".doco", "project-tokens.json"),
      JSON.stringify({ other: "doco_pt_other", acme: "doco_pt_file" }),
    );
    const config = resolveConfig({}, join(cwd, "packages", "web"));
    expect(config).toMatchObject({ root: cwd, origin, workspace: "acme", token: "doco_pt_file" });
    expect(requestFor({ hook_event_name: "UserPromptSubmit", prompt: "x" }, config)?.url).toBe(
      `${origin}/api/v1/brief.json?workspace=acme&format=text&about=x&budget=4000`,
    );
    const out = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: session(), prompt: "ship it" },
      {},
      join(cwd, "packages", "web"),
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(requests[0]).toEqual({
      url: "/api/v1/brief.json?workspace=acme&format=text&about=ship+it&budget=4000",
      authorization: "Bearer doco_pt_file",
    });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("asks for nothing on other events, empty prompts, slash commands and edits without a path", () => {
    const config = resolveConfig(
      { DOCO_ORIGIN: origin, DOCO_TOKEN: "t", DOCO_WORKSPACE: "acme" },
      tmpdir(),
    );
    expect(requestFor({ hook_event_name: "Stop" }, config)).toBeNull();
    expect(requestFor({ hook_event_name: "UserPromptSubmit", prompt: "  " }, config)).toBeNull();
    expect(
      requestFor({ hook_event_name: "UserPromptSubmit", prompt: "/clear" }, config),
    ).toBeNull();
    expect(requestFor({ hook_event_name: "AfterTool" }, config)).toBeNull();
    expect(
      requestFor({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } }, config),
    ).toBeNull();
    expect(
      requestFor({ hook_event_name: "BeforeTool", tool_input: { file_path: "a.ts" } }, config),
    ).toBeNull();
  });

  // decision_01M4C2J610DPD028P55Q8X6VG2: a fresh clone has the hook but not
  // the token, which stays out of git; the agent gets its person's back.
  it("without a token, tells the agent to get its own from doco_hook_token, and asks Doco nothing", async () => {
    const cwd = project();
    const env = { DOCO_ORIGIN: origin, DOCO_WORKSPACE: "acme" };
    const context = (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext;
    const note =
      "The Doco hook has no token here: call doco_hook_token for acme, save the token as it says, and the hook briefs you from the next prompt on.";
    const start = await runHook({ hook_event_name: "SessionStart", cwd }, env, cwd);
    expect([start.code, context(start.stdout)]).toEqual([0, note]);
    const prompt = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: session(), cwd, prompt: "x" },
      env,
      cwd,
    );
    expect(context(prompt.stdout)).toBe(`${DOCO_REMINDER}\n\n${note}`);
    const edit = await runHook(
      {
        hook_event_name: "PreToolUse",
        session_id: session(),
        cwd,
        tool_input: { file_path: "a.ts" },
      },
      env,
      cwd,
    );
    expect([edit.code, edit.stdout]).toEqual([0, ""]);
    expect(requests).toHaveLength(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("fails open: a failing route, a slow route and bad stdin leave the reminder alone, exit 0", async () => {
    const cwd = project();
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: session(), cwd, prompt: "x" };
    const reminderOnly = JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DOCO_REMINDER },
    });
    respond = () => ({ status: 500, body: "boom" });
    const failing = await runHook(prompt, { DOCO_ORIGIN: origin, DOCO_TOKEN: "t" }, cwd);
    expect([failing.code, failing.stdout.trim()]).toEqual([0, reminderOnly]);

    respond = () => ({ status: 200, body: "late", delayMs: 1500 });
    const started = Date.now();
    const slow = await runHook(
      prompt,
      { DOCO_ORIGIN: origin, DOCO_TOKEN: "t", DOCO_HOOK_TIMEOUT_MS: "200" },
      cwd,
    );
    expect([slow.code, slow.stdout.trim()]).toEqual([0, reminderOnly]);
    expect(Date.now() - started).toBeLessThan(1400);
    const edit = { ...prompt, hook_event_name: "PreToolUse", tool_input: { file_path: "a.ts" } };
    const slowEdit = await runHook(
      edit,
      { DOCO_ORIGIN: origin, DOCO_TOKEN: "t", DOCO_HOOK_TIMEOUT_MS: "200" },
      cwd,
    );
    expect([slowEdit.code, slowEdit.stdout]).toEqual([0, ""]);
    respond = () => ({ status: 200, body: "fine" });

    const bad = await new Promise<{ stdout: string; code: number | null }>((done) => {
      const child = spawn(process.execPath, [HOOK], { cwd, env: { PATH: process.env.PATH } });
      let stdout = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.on("close", (code) => done({ stdout, code }));
      child.stdin.end("not json");
    });
    expect([bad.code, bad.stdout]).toEqual([0, ""]);
    rmSync(cwd, { recursive: true, force: true });
  });
});
