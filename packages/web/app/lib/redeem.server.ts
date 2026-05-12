// Server-only re-export. Keeps `@doco/api`'s server-only chain (better-sqlite3,
// hono, etc.) out of the client bundle. See lib/tokens.server.ts.
export { redeemInvitation, findPrincipalById, addAgentPrincipal, suggestScopes } from "@doco/api";
export type {
  RedemptionResult,
  RedemptionError,
  RedemptionBody,
  ScopeSuggestion,
  SuggestScopesOptions,
} from "@doco/api";
export {
  createDocoInHost,
  createScopeInDoco,
  deleteScopeInDoco,
  materializeScopeTree,
  migrateScopesInDoco,
  parseScopeNamesInput,
  updateScopeInDoco,
} from "@doco/host";
export { reindex } from "@doco/index";
