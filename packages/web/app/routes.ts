import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("e/:type", "routes/e.$type._index.tsx"),
  route("e/:type/:id", "routes/e.$type.$id.tsx"),
  route("search", "routes/search.tsx"),
  route("lint", "routes/lint.tsx"),
] satisfies RouteConfig;
