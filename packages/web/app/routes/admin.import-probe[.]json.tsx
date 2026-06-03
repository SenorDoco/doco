// TEMPORARY diagnostic endpoint — /admin/import-probe.json
//
// Added to read torre-prs's GitHub PR-import progress from production while the
// Doco MCP read path was unavailable. Gated by a secret token whose SHA-256 is
// the only thing in source (a hash is not reversible, so committing it leaks
// nothing). A wrong/absent token gets a generic 404 so the route's existence
// isn't revealed. REMOVE THIS FILE once the import is verified.
import { createHash, timingSafeEqual } from "node:crypto";
import { withClient } from "@doco/db";
import {
  normalizeBackfillState,
  normalizeConnections,
  summarizeBackfillForStatus,
} from "~/lib/github-connection.server";

const TOKEN_SHA256 = "985d254860220885d8032858e7a563ffed34fb202c6d3c5da4d39b2d1e15506d";

/** torre/torre-prs */
const DOCO_ID = "doco_01KT2R6SHZEDD3TT906TSAFBZ9";

function authorized(request: Request): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? request.headers.get("x-probe-token") ?? "";
  if (!token) return false;
  const got = createHash("sha256").update(token).digest();
  const want = Buffer.from(TOKEN_SHA256, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function loader({ request }: { request: Request }) {
  if (!authorized(request)) return new Response("Not Found", { status: 404 });
  try {
    const data = await withClient(async (c) => {
      const refs = await c.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM nodes WHERE doco_id = $1 AND node_type = 'reference'",
        [DOCO_ID],
      );
      const gh = await c.query<{ gh: unknown }>(
        "SELECT data->'github_integration' AS gh FROM docos WHERE id = $1",
        [DOCO_ID],
      );
      const ghVal = gh.rows[0]?.gh;
      const marker = normalizeBackfillState(ghVal);
      const byRepo = await c.query<{ repo: string; n: string }>(
        `SELECT split_part(replace(locator, 'https://github.com/', ''), '/pull/', 1) AS repo,
                count(*)::text AS n
           FROM nodes
          WHERE doco_id = $1
            AND node_type = 'reference'
            AND locator LIKE 'https://github.com/%/pull/%'
          GROUP BY 1
          ORDER BY count(*) DESC
          LIMIT 80`,
        [DOCO_ID],
      );
      return {
        references_total: Number(refs.rows[0]?.n ?? 0),
        connections: normalizeConnections(ghVal).length,
        github_import: summarizeBackfillForStatus(marker),
        backfill_raw: marker,
        repos_imported: byRepo.rows.length,
        by_repo: byRepo.rows.map((r) => ({ repo: r.repo, count: Number(r.n) })),
        now: new Date().toISOString(),
      };
    });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
