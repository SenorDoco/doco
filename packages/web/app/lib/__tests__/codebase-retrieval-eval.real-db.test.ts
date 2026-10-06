// Adversarial local retrieval eval: can Doco find a small, current fact in a
// growing codebase full of topically similar and contradictory files? This
// exercises the production code search against real Postgres semantics. It
// does not involve Señor Doco or a model.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { searchCodebase } from "../codebase-read.server";

const HAYSTACK_DISTRACTORS = process.env.DOCO_EVAL_STRESS
  ? ([10, 100, 1_000, 10_000] as const)
  : ([10, 100, 1_000] as const);
const SDKMAN_ANSWER = /java=8\.0\.472-amzn/i;
const WORKFLOW_ANSWER = /java-version:\s*["']?8\b/i;
const INTENT_VARIANTS = [
  {
    query: "What JDK version does Solar use?",
    paths: [".sdkmanrc", ".github/workflows/build.yml"],
    answer: /(?:java=8\.0\.472-amzn|java-version:\s*["']?8\b)/i,
  },
  {
    query: "Which Java version is Solar on?",
    paths: [".sdkmanrc", ".github/workflows/build.yml"],
    answer: /(?:java=8\.0\.472-amzn|java-version:\s*["']?8\b)/i,
  },
  {
    query: "What JVM is the Solar build pinned to?",
    paths: [".sdkmanrc", ".github/workflows/build.yml"],
    answer: /(?:java=8\.0\.472-amzn|java-version:\s*["']?8\b)/i,
  },
  {
    query: "Is Solar using Java 8, 11, or 17?",
    paths: [".sdkmanrc", ".github/workflows/build.yml"],
    answer: /(?:java=8\.0\.472-amzn|java-version:\s*["']?8\b)/i,
  },
  {
    query: "Which Java SDK is Solar pinned to locally?",
    paths: [".sdkmanrc"],
    answer: SDKMAN_ANSWER,
  },
  {
    query: "What JDK version does Solar CI install?",
    paths: [".github/workflows/build.yml"],
    answer: WORKFLOW_ANSWER,
  },
] as const;

let db: PGlite;

async function insertFile(
  docoId: string,
  repo: string,
  path: string,
  content: string,
): Promise<void> {
  await db.query(
    `INSERT INTO code_files (doco_id, repo, path, sha, size, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [docoId, repo, path, `sha-${repo}-${path}`, content.length, content],
  );
}

beforeAll(async () => {
  db = await freshDb();
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_torre', 'torre', 'Torre')",
  );

  for (const size of HAYSTACK_DISTRACTORS) {
    const docoId = `doco_code_${size}`;
    await db.query(
      `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data)
       VALUES ($1, $2, 'workspace_torre', 'workspace_torre', 'private',
               '{"template_handle":"codebase"}'::jsonb)`,
      [docoId, `torre-codebase-${size}`],
    );

    await insertFile(
      docoId,
      "torre/solar",
      ".sdkmanrc",
      ["java=8.0.472-amzn", "scala=2.12.15", "sbt=1.3.13"].join("\n"),
    );
    await insertFile(
      docoId,
      "torre/solar",
      ".github/workflows/build.yml",
      [
        "name: build",
        ...Array.from({ length: 250 }, (_, i) => `# setup detail ${i + 1}`),
        "      distribution: temurin",
        '      java-version: "8"',
        ...Array.from({ length: 250 }, (_, i) => `# build detail ${i + 1}`),
      ].join("\n"),
    );
    await insertFile(
      docoId,
      "torre/solar",
      "docs/jdk-17-migration.md",
      "Proposal only: Solar may migrate from Java 8 to JDK 17. This is not the current runtime.",
    );

    await db.query(
      `INSERT INTO code_files (doco_id, repo, path, sha, size, content)
       SELECT $1,
              'torre/service-' || lpad(i::text, 5, '0'),
              '.github/workflows/build.yml',
              'distractor-' || i,
              length(body),
              body
         FROM (
           SELECT i,
                  'name: build' || E'\n' ||
                  'service: service-' || lpad(i::text, 5, '0') || E'\n' ||
                  'distribution: temurin' || E'\n' ||
                  'java-version: "' || CASE WHEN i % 3 = 0 THEN '11' ELSE '17' END || '"' AS body
             FROM generate_series(1, $2::int) AS i
         ) distractors`,
      [docoId, size],
    );
  }
});

describe.each(HAYSTACK_DISTRACTORS)("Solar JDK intent with %i distractors", (size) => {
  it.each(INTENT_VARIANTS)("delivers answer-bearing evidence for: $query", async (testCase) => {
    const hits = await searchCodebase(db, `doco_code_${size}`, testCase.query, 20);
    const evidenceRank = hits.findIndex(
      (hit) =>
        hit.repo === "torre/solar" &&
        testCase.paths.some((path) => path === hit.path) &&
        hit.matches.some((match) => testCase.answer.test(match.text)),
    );

    expect(
      evidenceRank,
      `expected answer-bearing Solar evidence in the top five; got ${JSON.stringify(
        hits.map((hit) => ({ repo: hit.repo, path: hit.path, matches: hit.matches })),
      )}`,
    ).toBeGreaterThanOrEqual(0);
    expect(evidenceRank).toBeLessThan(5);
  });
});

it("does not hard-code Solar while finding a late, contradictory service needle", async () => {
  const largest = HAYSTACK_DISTRACTORS.at(-1) as number;
  const service = `service-${String(largest - 1).padStart(5, "0")}`;
  const expectedVersion = (largest - 1) % 3 === 0 ? "11" : "17";
  const hits = await searchCodebase(db, `doco_code_${largest}`, `JDK version for ${service}`, 20);

  expect(hits[0]).toMatchObject({
    repo: `torre/${service}`,
    path: ".github/workflows/build.yml",
    matches: expect.arrayContaining([
      expect.objectContaining({ text: `java-version: "${expectedVersion}"` }),
    ]),
  });
});
