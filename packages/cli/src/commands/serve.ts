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

    const app = makeApp({
      docoRoot: root,
      log: true,
    });

    console.log();
    console.log(header(`Doco API`));
    console.log(rule());
    console.log(checkmark(`Listening on  http://${host}:${port}`));
    console.log(checkmark(`Doco root:    ${c.dim(root)}`));
    console.log(rule());
    console.log(c.dim(`API:  curl http://${host}:${port}/api/v1/doco`));
    console.log(c.dim(`Web:  pnpm --filter @doco/web dev   (Remix on http://127.0.0.1:5173)`));
    console.log();

    serve({ fetch: app.fetch, hostname: host, port });
  },
});
