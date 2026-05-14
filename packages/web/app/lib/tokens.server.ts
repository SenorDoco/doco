// Server-only re-export. The `.server.ts` suffix tells Remix / React Router's
// Vite plugin to strip this module — and its `@doco/api` import chain (hono,
// pg, etc.) — from the client bundle entirely.
export { TokenStore } from "@doco/api";
