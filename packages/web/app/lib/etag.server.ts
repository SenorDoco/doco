// ETag / conditional GET helper. RFC 7232 semantics:
//
//   - Server computes a content hash, returns it in the `ETag` header.
//   - Client retains it and sends `If-None-Match: "<etag>"` on the
//     next request.
//   - Server compares: match → 304 Not Modified with empty body and
//     no Content-Type (per RFC); mismatch → 200 with fresh body +
//     new ETag.
//
// Saves bandwidth + parse cost on the hot path: SessionStart fetches
// the canonical every session; UserPromptSubmit hits search.json
// every user message. Both are read-heavy and rarely change between
// consecutive calls.
//
// The hash is a 16-char prefix of sha256(content) — collision-safe
// in practice and short enough to keep response headers small. Weak
// ETags (`W/"<hash>"`) aren't used; we always emit strong because
// the JSON bodies are byte-equivalent representations.

import { createHash } from "node:crypto";

function computeETag(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * Build a JSON Response with an ETag header. If the request's
 * `If-None-Match` matches, returns a 304 with no body. Otherwise
 * returns a 200 with the body and the ETag header set.
 *
 * `options.stableData` is the subset of the response used to compute
 * the ETag. Defaults to the full response body. Pass an alternative
 * when the response includes non-deterministic fields (timing,
 * request id) that shouldn't bust the cache.
 *
 * `options.extraHeaders` is applied to both the 200 and 304 paths
 * (Cache-Control, Vary, etc.).
 */
export function etaggedJson(
  request: Request,
  data: unknown,
  options: { stableData?: unknown; extraHeaders?: Record<string, string> } = {},
): Response {
  const body = JSON.stringify(data);
  const hashInput = options.stableData === undefined ? body : JSON.stringify(options.stableData);
  const etag = `"${computeETag(hashInput)}"`;
  const extraHeaders = options.extraHeaders ?? {};
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        ...extraHeaders,
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      ETag: etag,
      ...extraHeaders,
    },
  });
}
