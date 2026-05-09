import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import { runAllLints } from "@evalo/lints";
import { Glossary, findRules } from "@evalo/discovery";
import { Layout } from "./layout.js";

export interface WebServerOptions {
  evaloRoot: string;
}

export function makeWebApp(opts: WebServerOptions): Hono {
  const app = new Hono();
  let glossaryPromise: Promise<Glossary> | null = null;
  const getGlossary = () => {
    if (!glossaryPromise) glossaryPromise = Glossary.load(opts.evaloRoot);
    return glossaryPromise;
  };

  function db(): Database {
    return new BetterSqlite3(`${opts.evaloRoot}/.evalo/cache.db`, {
      readonly: true,
      fileMustExist: true,
    });
  }

  function evaloSlug(): string {
    const d = db();
    try {
      const row = d.prepare("SELECT slug FROM evalo_root LIMIT 1").get() as { slug: string };
      return row.slug;
    } finally {
      d.close();
    }
  }

  // Home — recent changes feed (D-045)
  app.get("/", (c) => {
    const d = db();
    try {
      const items = d
        .prepare(
          `SELECT id, node_type, summary, created_at, slug, number, title FROM (
             SELECT id, 'decision' AS node_type, summary, created_at, slug, number, NULL AS title FROM decision
             UNION ALL
             SELECT id, 'intent' AS node_type, summary, created_at, slug, NULL, title FROM intent
             UNION ALL
             SELECT id, 'rule' AS node_type, summary, created_at, slug, NULL, NULL FROM rule
             UNION ALL
             SELECT id, 'action' AS node_type, summary, created_at, NULL, NULL, NULL FROM action
             UNION ALL
             SELECT id, 'reasoning' AS node_type, summary, created_at, NULL, NULL, NULL FROM reasoning
           )
           ORDER BY created_at DESC LIMIT 30`,
        )
        .all() as {
        id: string;
        node_type: string;
        summary: string;
        created_at: string;
        slug: string | null;
        number: string | null;
        title: string | null;
      }[];

      return c.html(
        <Layout title="Recent" evaloSlug={evaloSlug()}>
          <div class="panel">
            <h2 style="margin: 0 0 8px 0">Recent activity</h2>
            <div class="muted" style="font-size: 12px">
              Last 30 entities across decisions, intents, rules, actions, reasonings — chronological. (D-045)
            </div>
          </div>
          <div class="panel">
            {items.map((it) => (
              <div class="feed-item">
                <div class="feed-title">
                  <span class={`badge ${it.node_type === "decision" ? "adr" : ""}`}>{it.node_type}</span>
                  {it.number ? <span class="badge adr">{it.number}</span> : null}
                  <a href={`/e/${it.node_type}/${it.id}`}>{it.title ?? it.slug ?? it.id}</a>
                </div>
                <div class="feed-meta">
                  {it.summary} <span class="mono"> · {it.created_at}</span>
                </div>
              </div>
            ))}
          </div>
        </Layout>,
      );
    } finally {
      d.close();
    }
  });

  // List by type
  app.get("/e/:type", (c) => {
    const type = c.req.param("type");
    if (!isKnownType(type)) return c.html(notFound("Unknown type", evaloSlug()), 404);
    const d = db();
    try {
      const rows = d
        .prepare(`SELECT id, summary, raw_json FROM ${type} ORDER BY id DESC LIMIT 100`)
        .all() as { id: string; summary: string; raw_json: string }[];

      return c.html(
        <Layout title={`${type}s`} evaloSlug={evaloSlug()}>
          <div class="panel">
            <h2 style="margin: 0">{titleCase(type)}s ({rows.length})</h2>
          </div>
          <div class="panel">
            <table>
              <thead>
                <tr>
                  <th>id / slug</th>
                  <th>summary</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ent = JSON.parse(r.raw_json) as Record<string, unknown>;
                  const display =
                    (ent.slug as string | undefined) ?? (ent.title as string | undefined) ?? (ent.name as string | undefined) ?? r.id;
                  return (
                    <tr>
                      <td>
                        <a href={`/e/${type}/${r.id}`}>{display}</a>
                        {ent.number ? <span class="badge adr" style="margin-left: 8px">{String(ent.number)}</span> : null}
                      </td>
                      <td class="muted" style="font-size: 12.5px">{r.summary}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Layout>,
      );
    } finally {
      d.close();
    }
  });

  // Entity detail
  app.get("/e/:type/:id", (c) => {
    const type = c.req.param("type");
    const id = c.req.param("id");
    if (!isKnownType(type)) return c.html(notFound("Unknown type", evaloSlug()), 404);
    const d = db();
    try {
      const row = d.prepare(`SELECT raw_json FROM ${type} WHERE id = ?`).get(id) as
        | { raw_json: string }
        | undefined;
      if (!row) return c.html(notFound(`Not found: ${id}`, evaloSlug()), 404);
      const ent = JSON.parse(row.raw_json) as Record<string, unknown>;

      // edges (outgoing)
      const outgoing = d
        .prepare(
          "SELECT to_id, to_node_type, edge_type FROM edges WHERE from_id = ? ORDER BY edge_type",
        )
        .all(id) as { to_id: string; to_node_type: string; edge_type: string }[];

      const display =
        (ent.slug as string | undefined) ?? (ent.title as string | undefined) ?? (ent.name as string | undefined) ?? id;

      return c.html(
        <Layout title={`${display} (${type})`} evaloSlug={evaloSlug()}>
          <div class="panel">
            <div class="muted mono">{id}</div>
            <h2 style="margin: 4px 0 8px 0">{display}</h2>
            <div class="row">
              <span class="badge">{type}</span>
              {ent.number ? <span class="badge adr">{String(ent.number)}</span> : null}
              {ent.lifecycle ? <span class="badge">lifecycle: {String(ent.lifecycle)}</span> : null}
              {ent.status ? <span class="badge">status: {String(ent.status)}</span> : null}
            </div>
            {ent.summary ? <div class="muted">{String(ent.summary)}</div> : null}
          </div>

          {outgoing.length > 0 ? (
            <div class="panel">
              <h3 style="margin: 0 0 8px 0">Edges (outgoing)</h3>
              <table>
                <thead>
                  <tr>
                    <th>edge type</th>
                    <th>target</th>
                  </tr>
                </thead>
                <tbody>
                  {outgoing.map((e) => (
                    <tr>
                      <td class="mono">{e.edge_type}</td>
                      <td>
                        <a href={`/e/${e.to_node_type}/${e.to_id}`}>{e.to_id}</a>{" "}
                        <span class="muted">({e.to_node_type})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div class="panel">
            <h3 style="margin: 0 0 8px 0">Raw entity</h3>
            <pre>{JSON.stringify(ent, null, 2)}</pre>
          </div>
        </Layout>,
      );
    } finally {
      d.close();
    }
  });

  // Search (FTS5 over summary+body) + Rule discovery
  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const d = db();
    try {
      const slug = evaloSlug();
      if (!q) {
        return c.html(
          <Layout title="Search" evaloSlug={slug}>
            <SearchForm q="" />
            <div class="panel muted">
              Enter a query above. Searches summary + body via FTS5; finds applicable Rules via the
              5-strategy retrieval (D-030).
            </div>
          </Layout>,
        );
      }

      // FTS results across all entities
      const fts = d
        .prepare(
          `SELECT id, node_type, summary FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 20`,
        )
        .all(q) as { id: string; node_type: string; summary: string }[];

      // find-rules result
      const glossary = await getGlossary();
      const ruleResult = findRules(d, glossary, { description: q });

      return c.html(
        <Layout title={`Search: ${q}`} evaloSlug={slug}>
          <SearchForm q={q} />
          <div class="panel">
            <h3 style="margin: 0 0 8px 0">FTS matches ({fts.length})</h3>
            <table>
              <thead>
                <tr>
                  <th>type</th>
                  <th>id / summary</th>
                </tr>
              </thead>
              <tbody>
                {fts.map((r) => (
                  <tr>
                    <td><span class="badge">{r.node_type}</span></td>
                    <td>
                      <a href={`/e/${r.node_type}/${r.id}`}>{r.id}</a>
                      <div class="muted" style="font-size: 12.5px">{r.summary}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="panel">
            <h3 style="margin: 0 0 8px 0">find-rules → possibly relevant</h3>
            <table>
              <thead>
                <tr>
                  <th>rule</th>
                  <th>summary</th>
                </tr>
              </thead>
              <tbody>
                {ruleResult.possiblyRelevant.map((h) => (
                  <tr>
                    <td>
                      <a href={`/e/rule/${h.rule_id}`}>{h.rule_slug ?? h.rule_id}</a>
                      <div class="muted" style="font-size: 11px">{h.reason}</div>
                    </td>
                    <td class="muted" style="font-size: 12.5px">{h.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Layout>,
      );
    } finally {
      d.close();
    }
  });

  // Lint report
  app.get("/lint", (c) => {
    const d = db();
    try {
      const report = runAllLints(d);
      const slug = evaloSlug();
      return c.html(
        <Layout title="Lint" evaloSlug={slug}>
          <div class="panel">
            <h2 style="margin: 0 0 8px 0">Lint report</h2>
            <div class="row">
              <span class={`badge ${report.errors === 0 ? "ok" : "err"}`}>
                {report.errors} errors
              </span>
              <span class={`badge ${report.warnings === 0 ? "ok" : "warn"}`}>
                {report.warnings} warnings
              </span>
            </div>
          </div>
          <div class="panel">
            <table>
              <thead>
                <tr>
                  <th>lint</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.issuesByLint).map(([name, issues]) => (
                  <tr>
                    <td class="mono">{name}</td>
                    <td>
                      {issues.length === 0 ? (
                        <span class="badge ok">clean</span>
                      ) : (
                        <span class="badge err">{issues.length} issue(s)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.issues.length > 0 ? (
              <ul>
                {report.issues.map((iss) => (
                  <li>
                    <span class={`badge ${iss.severity === "error" ? "err" : "warn"}`}>
                      {iss.lintId}
                    </span>{" "}
                    <a href={`/e/${guessTypeFromId(iss.source)}/${iss.source}`}>{iss.source}</a> —{" "}
                    {iss.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Layout>,
      );
    } finally {
      d.close();
    }
  });

  return app;
}

const SearchForm = ({ q }: { q: string }) => (
  <form class="search" method="get" action="/search">
    <input
      type="search"
      name="q"
      value={q}
      placeholder="Search entities or describe a Rule context..."
      autoFocus
    />
    <button type="submit">Search</button>
  </form>
);

function notFound(msg: string, slug: string) {
  return (
    <Layout title="Not found" evaloSlug={slug}>
      <div class="panel">
        <h2>Not found</h2>
        <div class="muted">{msg}</div>
      </div>
    </Layout>
  );
}

function isKnownType(t: string): boolean {
  return ["principal", "intent", "rule", "decision", "action", "reasoning", "evaluation", "reference", "tag"].includes(t);
}

function guessTypeFromId(id: string): string {
  const m = /^([a-z]+)_/.exec(id);
  return m ? (m[1] as string) : "";
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
