import { defineCommand } from "citty";
import { serve } from "@hono/node-server";
import { makeApp } from "@doco/api";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

export const serveCmd = defineCommand({
  meta: {
    name: "serve",
    description: "Run the Doco REST API on localhost.",
  },
  args: {
    port: { type: "string", description: "Port (default 8787).", default: "8787" },
    host: { type: "string", description: "Host (default 127.0.0.1).", default: "127.0.0.1" },
    root: { type: "string", description: "Path to the Doco root (default: walk upward from cwd)." },
    "require-token": {
      type: "boolean",
      description: "Require a Bearer token on every request. Default false (local dev).",
      default: false,
    },
    "as-principal": {
      type: "string",
      description: "Default principal id for unauthenticated requests (local dev).",
    },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }
    const port = Number(args.port);
    const host = args.host as string;
    const requireToken = args["require-token"] as boolean;
    const defaultPrincipal = (args["as-principal"] as string | undefined) ?? undefined;

    const app = makeApp({
      docoRoot: root,
      requireToken,
      ...(defaultPrincipal !== undefined ? { defaultPrincipalId: defaultPrincipal } : {}),
      log: true,
    });

    console.log();
    console.log(header(`Doco API`));
    console.log(rule());
    console.log(checkmark(`Listening on  http://${host}:${port}`));
    console.log(checkmark(`Doco root:   ${c.dim(root)}`));
    console.log(checkmark(`Auth:         ${requireToken ? "Bearer required" : "open (local dev)"}`));
    if (defaultPrincipal) console.log(checkmark(`Acting as:    ${defaultPrincipal}`));
    console.log(rule());
    console.log(c.dim(`API:  curl http://${host}:${port}/api/v1/doco`));
    console.log(c.dim(`Web:  pnpm --filter @doco/web dev   (Remix on http://127.0.0.1:5173)`));
    console.log();

    serve({ fetch: app.fetch, hostname: host, port });
  },
});
