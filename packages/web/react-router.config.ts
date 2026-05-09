import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "app",
  ssr: true,
  // SSR-only data routes; no SPA prerender for now.
} satisfies Config;
