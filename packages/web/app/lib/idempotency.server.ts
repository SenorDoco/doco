// Idempotency-Key support for POST endpoints. Agents retry POSTs on
// transient failures (timeout, 5xx, dropped connection) and without
// this layer end up creating duplicate Decisions / Intents / Rules /
// Actions / Reasoning / Evals. The GitHub-style contract:
//
//   - Client sends `Idempotency-Key: <opaque-string>` on POST.
//   - Server stores (key, principal_id, body_hash) -> response for
//     RETENTION_MS. Same (key, principal) returns the cached response
//     verbatim — same status, same headers, same body.
//   - If the body hash differs (client bug: reused key with new body),
//     return 422 with a clear error.
//   - Without the header, behaviour is unchanged — captures retry as
//     before, duplicates possible.
//
// Storage: in-memory Map. Process restart wipes the cache, which is
// acceptable — Idempotency-Key is for protecting against retries
// within the same request session (seconds to minutes), not for
// cross-process replay protection. Anyone needing the latter rolls
// their own at the load balancer or fronts the endpoint with a queue.

import { createHash } from "node:crypto";

const RETENTION_MS = 10 * 60 * 1000; // 10 min
const MAX_ENTRIES = 5000;

interface CachedResponse {
  status: number;
  bodyHash: string;
  bodyText: string;
  headers: Record<string, string>;
  storedAt: number;
}

const cache = new Map<string, CachedResponse>();

function sweep(now: number): void {
  if (cache.size < MAX_ENTRIES) {
    // Fast path: only sweep when we're close to the cap. The full
    // sweep is O(n); RETENTION_MS guarantees old entries fade.
    return;
  }
  for (const [k, v] of cache) {
    if (now - v.storedAt > RETENTION_MS) cache.delete(k);
  }
  // If still over-cap after sweep (a lot of fresh entries), evict
  // FIFO until we're back under. Map preserves insertion order.
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function key(idempotencyKey: string, principalId: string, endpoint: string): string {
  return `${principalId}|${endpoint}|${idempotencyKey}`;
}

function hashBody(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface IdempotencyResult {
  // Cached response to return verbatim. Caller should pass it through.
  cached: Response;
}

/**
 * Look up a prior response for (Idempotency-Key, principalId, endpoint).
 *
 *   - Returns `{cached: Response}` when a prior response exists and
 *     the body hash matches the current request — caller returns it
 *     verbatim.
 *   - Returns a `{cached: <422 Response>}` when the key was reused
 *     with a different body (client bug).
 *   - Returns null when no prior call exists — caller proceeds with
 *     the actual handler.
 *
 * `endpoint` is a free-form identifier (e.g. `POST /api/decisions`)
 * used to scope keys to specific routes so a client that reuses a
 * key across endpoints doesn't get cross-contamination.
 */
export function checkIdempotencyKey(
  idempotencyKey: string,
  principalId: string,
  endpoint: string,
  requestBodyText: string,
): IdempotencyResult | null {
  const now = Date.now();
  const k = key(idempotencyKey, principalId, endpoint);
  const prior = cache.get(k);
  if (!prior) return null;
  if (now - prior.storedAt > RETENTION_MS) {
    cache.delete(k);
    return null;
  }
  const currentHash = hashBody(requestBodyText);
  if (currentHash !== prior.bodyHash) {
    return {
      cached: new Response(
        JSON.stringify({
          error:
            "Idempotency-Key was reused with a different request body. Use a fresh key, or send the exact same body.",
        }),
        {
          status: 422,
          headers: { "content-type": "application/json" },
        },
      ),
    };
  }
  return {
    cached: new Response(prior.bodyText, {
      status: prior.status,
      headers: { ...prior.headers, "idempotency-replay": "true" },
    }),
  };
}

/**
 * High-level wrapper: read the request body once, check + cache
 * against the Idempotency-Key, and run the handler. No-ops when the
 * header isn't present (or no principal id). Caller is responsible
 * for passing a stable `endpoint` identifier — typically a string
 * like `POST /api/decisions` — so a client that reuses a key across
 * different endpoints doesn't get cross-contamination.
 */
export async function withIdempotency(
  request: Request,
  endpoint: string,
  principalId: string | null,
  bodyText: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (!key || !principalId) return handler();
  const replay = checkIdempotencyKey(key, principalId, endpoint, bodyText);
  if (replay) return replay.cached;
  const response = await handler();
  await storeIdempotentResponse(key, principalId, endpoint, bodyText, response);
  return response;
}

/**
 * Store a response for future replay under (Idempotency-Key,
 * principalId, endpoint). Sweeps expired entries lazily.
 */
export async function storeIdempotentResponse(
  idempotencyKey: string,
  principalId: string,
  endpoint: string,
  requestBodyText: string,
  response: Response,
): Promise<Response> {
  // Clone before reading the body so the original Response can still
  // be returned to the client.
  const clone = response.clone();
  const bodyText = await clone.text();
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    headers[name] = value;
  }
  const now = Date.now();
  sweep(now);
  cache.set(key(idempotencyKey, principalId, endpoint), {
    status: response.status,
    bodyHash: hashBody(requestBodyText),
    bodyText,
    headers,
    storedAt: now,
  });
  return response;
}
