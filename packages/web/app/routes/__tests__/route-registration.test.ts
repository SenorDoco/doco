import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Routing is explicit in app/routes.ts (not filesystem auto-discovery), so a
// route MODULE existing under app/routes/ does NOT make it reachable — it also
// needs a route() line. /api/v1/whoami.json shipped a module + lib + unit
// tests but was never registered, so it 404'd in production the whole time
// (the unit tests call loadAgentIdentity directly, never the HTTP route, so
// nothing caught it). This guards the class: every api/v1 *.json endpoint file
// must be wired into the route table.
const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, "..");
const routesConfig = readFileSync(join(here, "..", "..", "routes.ts"), "utf8");

const apiJsonRouteFiles = readdirSync(routesDir).filter((f) =>
  /^api\.v1\..*\[\.\]json\.tsx$/.test(f),
);

describe("api/v1 route registration", () => {
  it("has api/v1 json route modules to check", () => {
    expect(apiJsonRouteFiles.length).toBeGreaterThan(5);
  });

  it.each(apiJsonRouteFiles)("registers %s in routes.ts (no orphan endpoints)", (file) => {
    expect(routesConfig).toContain(file);
  });
});
