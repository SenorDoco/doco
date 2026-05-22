// `doco export <path>` — read the filesystem-shaped Doco at the given
// path (the legacy ADR-002 layout) and write a portable bundle: a
// directory containing `manifest.json` + one JSONL file per node type
// + an `audit.log` copy.
//
// The bundle is the wire format for migrating between filesystem and
// Postgres storage (Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { parse as parseYaml } from "yaml";
import { c, checkmark, cross } from "../output.js";

const NODE_DIRS: Record<string, { dir: string; ext: "md" | "yaml" }> = {
  intent: { dir: "intents", ext: "md" },
  decision: { dir: "decisions", ext: "md" },
  rule: { dir: "rules", ext: "md" },
  guidance_primitive: { dir: "guidance_primitives", ext: "md" },
  neuron_authoring_primitive: { dir: "neuron_authoring_primitives", ext: "md" },
  action: { dir: "actions", ext: "md" },
  eval: { dir: "evals", ext: "md" },
  reference: { dir: "references", ext: "yaml" },
  idea: { dir: "ideas", ext: "md" },
  tag: { dir: "tags", ext: "yaml" },
};

interface ExportedRow {
  id: string;
  doco_id: string;
  entity_type: string;
  raw_yaml: string; // canonical JSON serialization of frontmatter
  body_md?: string;
  summary?: string | null;
  lifecycle?: string | null;
  name?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}

function parseEntityFile(filePath: string, entityType: string): ExportedRow | null {
  const text = readFileSync(filePath, "utf8");
  let fm: Record<string, unknown>;
  let body: string | undefined;
  if (filePath.endsWith(".md")) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return null;
    fm = parseYaml(m[1] ?? "") as Record<string, unknown>;
    body = (m[2] ?? "").replace(/^\n/, "");
  } else {
    fm = parseYaml(text) as Record<string, unknown>;
  }
  const id = String(fm.id ?? "");
  if (!id) return null;
  const docoId = String(fm.doco_id ?? "");
  const out: ExportedRow = {
    id,
    doco_id: docoId,
    entity_type: entityType,
    raw_yaml: JSON.stringify(fm),
  };
  if (body) out.body_md = body;
  if (typeof fm.summary === "string") {
    out.summary = fm.summary;
  }
  if (typeof fm.lifecycle === "string") out.lifecycle = fm.lifecycle;
  if (typeof fm.name === "string") out.name = fm.name;
  if (typeof fm.created_at === "string") out.created_at = fm.created_at;
  if (typeof fm.created_by === "string") out.created_by = fm.created_by;
  if (typeof fm.updated_at === "string") out.updated_at = fm.updated_at;
  if (typeof fm.updated_by === "string") out.updated_by = fm.updated_by;
  return out;
}

function walkType(srcRoot: string, entityType: string): ExportedRow[] {
  const spec = NODE_DIRS[entityType];
  if (!spec) return [];
  const dir = join(srcRoot, spec.dir);
  if (!existsSync(dir)) return [];
  const out: ExportedRow[] = [];
  const stack = [dir];
  const filenameRe = new RegExp(`^${entityType}_[A-Z0-9]{26}\\.${spec.ext}$`);
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(cur, e);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!filenameRe.test(e)) continue;
      const row = parseEntityFile(path, entityType);
      if (row) out.push(row);
    }
  }
  return out;
}

function walkIdentity(hostRoot: string, entityType: "principal" | "organization"): ExportedRow[] {
  const dir = join(hostRoot, entityType === "principal" ? "principals" : "organizations");
  if (!existsSync(dir)) return [];
  const out: ExportedRow[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml")) continue;
    const row = parseEntityFile(join(dir, f), entityType);
    if (row) {
      // Identity rows have no doco_id
      row.doco_id = "";
      out.push(row);
    }
  }
  return out;
}

function readDocoYaml(srcRoot: string): ExportedRow | null {
  const path = join(srcRoot, "doco.yaml");
  if (!existsSync(path)) return null;
  const fm = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  // Surface owner_slug + slug from path even if absent in yaml.
  return {
    id: String(fm.id ?? ""),
    doco_id: String(fm.id ?? ""),
    entity_type: "doco",
    raw_yaml: JSON.stringify(fm),
    name: typeof fm.name === "string" ? fm.name : null,
  };
}

export const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Export a filesystem-shaped Doco (legacy ADR-002 layout) as a portable bundle for migration into Postgres or off-site backup.",
  },
  args: {
    path: {
      type: "positional",
      description: "Path to the Doco directory (the one containing doco.yaml).",
      required: true,
    },
    out: {
      type: "string",
      description: "Output bundle directory. Defaults to <path>.bundle.",
    },
    "include-host": {
      type: "boolean",
      description:
        "Also include host-level principals + organizations from the Doco's grandparent (host.yaml directory). Default true when the parent looks like a host.",
    },
  },
  async run({ args }) {
    const srcRoot = resolve(process.cwd(), String(args.path));
    if (!existsSync(join(srcRoot, "doco.yaml"))) {
      console.error(cross(`No doco.yaml at ${srcRoot}.`));
      process.exit(2);
    }
    const outDir = args.out ? resolve(process.cwd(), String(args.out)) : `${srcRoot}.bundle`;
    mkdirSync(outDir, { recursive: true });

    // Detect host: walk up looking for host.yaml.
    let hostRoot: string | null = null;
    let probe = srcRoot;
    for (let i = 0; i < 6; i++) {
      probe = resolve(probe, "..");
      if (existsSync(join(probe, "host.yaml"))) {
        hostRoot = probe;
        break;
      }
    }

    const docoRow = readDocoYaml(srcRoot);
    if (!docoRow) {
      console.error(cross(`Could not parse doco.yaml at ${srcRoot}.`));
      process.exit(1);
    }

    const counts: Record<string, number> = {};
    let totalRows = 0;

    // Doco metadata.
    writeFileSync(join(outDir, "doco.jsonl"), `${JSON.stringify(docoRow)}\n`, "utf8");
    counts.doco = 1;
    totalRows++;

    // Per-type entities.
    for (const entityType of Object.keys(NODE_DIRS)) {
      const rows = walkType(srcRoot, entityType);
      if (rows.length === 0) continue;
      const file = join(outDir, `${entityType}.jsonl`);
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      counts[entityType] = rows.length;
      totalRows += rows.length;
    }

    // Host-level identity (principals, organizations).
    if (hostRoot && (args["include-host"] === true || args["include-host"] === undefined)) {
      for (const t of ["principal", "organization"] as const) {
        const rows = walkIdentity(hostRoot, t);
        if (rows.length === 0) continue;
        const file = join(outDir, `${t}.jsonl`);
        writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
        counts[t] = rows.length;
        totalRows += rows.length;
      }
    }

    // Audit log copy (if present).
    const auditSrc = join(srcRoot, ".doco", "audit.log");
    let auditCount = 0;
    if (existsSync(auditSrc)) {
      const lines = readFileSync(auditSrc, "utf8").split("\n").filter(Boolean);
      writeFileSync(join(outDir, "audit_events.jsonl"), `${lines.join("\n")}\n`, "utf8");
      auditCount = lines.length;
    }

    const manifest = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      doco_id: docoRow.id,
      source_root: srcRoot,
      host_root: hostRoot,
      counts,
      audit_events: auditCount,
      total_rows: totalRows,
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    console.log(
      checkmark(`Exported ${totalRows} entity row(s) + ${auditCount} audit event(s) to:`),
    );
    console.log(`  ${c.bold(outDir)}`);
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
  },
});
