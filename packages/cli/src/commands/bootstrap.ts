import { defineCommand } from "citty";
import { requireDocoConfig } from "../env.js";
import { cross } from "../output.js";

function normalizedHost(raw: unknown): string {
  const value = (typeof raw === "string" ? raw.trim() : "") || "https://doco.to";
  const withProtocol = /^https?:\/\//.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

async function fetchAgentJson(args: {
  url: URL;
  access: string;
  pretty: boolean;
  failureLabel: string;
}): Promise<void> {
  let resp: Response;
  let body = "";
  try {
    resp = await fetch(args.url, {
      headers: { Authorization: `Bearer ${args.access}` },
    });
    body = await resp.text();
  } catch (err) {
    console.error(cross(`${args.failureLabel} failed: ${(err as Error).message}`));
    console.error("HTTP_STATUS:000");
    process.exitCode = 1;
    return;
  }

  if (body) {
    if (args.pretty) {
      try {
        console.log(JSON.stringify(JSON.parse(body), null, 2));
      } catch {
        console.log(body);
      }
    } else {
      console.log(body);
    }
  }

  if (!resp.ok) {
    console.error(`HTTP_STATUS:${resp.status}`);
    process.exitCode = 1;
  }
}

export const bootstrapCmd = defineCommand({
  meta: {
    name: "bootstrap",
    description:
      "Fetch the agent bootstrap JSON. Reads DOCO_ACCESS from env or ./.env and keeps the credential out of shell commands.",
  },
  args: {
    host: {
      type: "string",
      description: "Doco host URL. Defaults to https://doco.to.",
    },
    ref: {
      type: "string",
      description: "Override the Doco handle/ref. Defaults to DOCO.md.",
    },
    id: {
      type: "string",
      description: "Legacy alias for --ref.",
    },
    pretty: {
      type: "boolean",
      description: "Pretty-print the returned JSON.",
      default: false,
    },
  },
  async run({ args }) {
    const { access, docoRef, host } = requireDocoConfig();
    const refArg =
      typeof args.ref === "string" && args.ref.trim()
        ? args.ref.trim()
        : typeof args.id === "string" && args.id.trim()
          ? args.id.trim()
          : "";
    const ref = refArg || docoRef;
    const url = new URL("/api/v1/agent-bootstrap", normalizedHost(args.host || host));
    if (ref) url.searchParams.set("id", ref);
    await fetchAgentJson({
      url,
      access,
      pretty: Boolean(args.pretty),
      failureLabel: "Bootstrap fetch",
    });
  },
});

export const searchCmd = defineCommand({
  meta: {
    name: "search",
    description:
      "Query this Doco's /search.json endpoint. Reads DOCO_ACCESS from env or ./.env and the Doco URL from DOCO.md, keeping the credential out of shell commands.",
  },
  args: {
    query: {
      type: "positional",
      description: "Search query text.",
      required: true,
    },
    limit: {
      type: "string",
      description: "Maximum hits to return. Default 10.",
      default: "10",
    },
    host: {
      type: "string",
      description: "Doco host URL. Defaults to https://doco.to.",
    },
    ref: {
      type: "string",
      description: "Override the Doco handle/ref. Defaults to DOCO.md.",
    },
    id: {
      type: "string",
      description: "Legacy alias for --ref.",
    },
    pretty: {
      type: "boolean",
      description: "Pretty-print the returned JSON.",
      default: false,
    },
  },
  async run({ args }) {
    const { access, docoRef, host } = requireDocoConfig();
    const refArg =
      typeof args.ref === "string" && args.ref.trim()
        ? args.ref.trim()
        : typeof args.id === "string" && args.id.trim()
          ? args.id.trim()
          : "";
    const ref = refArg || docoRef;
    const query = String(args.query ?? "").trim();
    if (!query) {
      console.error(cross("Provide a search query."));
      process.exitCode = 2;
      return;
    }
    const url = new URL(`/${encodeURIComponent(ref)}/search.json`, normalizedHost(args.host || host));
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(args.limit ?? "10"));
    await fetchAgentJson({
      url,
      access,
      pretty: Boolean(args.pretty),
      failureLabel: "Search",
    });
  },
});
