import type { FC, PropsWithChildren } from "hono/jsx";

const STYLE = `
  :root {
    --bg: #0e1116;
    --panel: #161a22;
    --panel-2: #1d2129;
    --text: #e6e8eb;
    --muted: #8a93a3;
    --link: #6cb6ff;
    --accent: #d8b974;
    --error: #ff6b6b;
    --ok: #4ec9b0;
    --warn: #d8b974;
    --border: #262b36;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    font-size: 14px;
    line-height: 1.55;
  }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  header.site {
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  header.site .container { display: flex; align-items: center; gap: 16px; padding: 12px 24px; }
  header.site h1 { font-size: 18px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  header.site nav a { margin-left: 16px; color: var(--muted); font-weight: 500; font-size: 13px; }
  header.site nav a:hover { color: var(--text); }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .panel.tight { padding: 8px 16px; }
  .row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .badge {
    display: inline-block;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    margin-right: 6px;
  }
  .badge.ok { color: var(--ok); border-color: var(--ok); }
  .badge.warn { color: var(--warn); border-color: var(--warn); }
  .badge.err { color: var(--error); border-color: var(--error); }
  .badge.adr { color: var(--accent); border-color: var(--accent); }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
  .feed-item { padding: 14px 0; border-bottom: 1px solid var(--border); }
  .feed-item:last-child { border-bottom: none; }
  .feed-title { font-size: 15px; font-weight: 600; margin-bottom: 2px; }
  .feed-meta { color: var(--muted); font-size: 12px; }
  pre {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    overflow-x: auto;
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.45;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  form.search { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
  form.search input {
    flex: 1;
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 14px;
    font-family: inherit;
  }
  form.search button {
    background: var(--link);
    color: var(--bg);
    border: none;
    border-radius: 6px;
    padding: 8px 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .body-md p { margin: 8px 0; }
  .body-md code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
`;

interface LayoutProps {
  title: string;
  evaloSlug: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, children, evaloSlug }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{`${title} · Evalo`}</title>
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    </head>
    <body>
      <header class="site">
        <div class="container">
          <h1>
            <a href="/">Evalo</a>{" "}
            <span class="muted" style="font-weight: 400">/ {evaloSlug}</span>
          </h1>
          <nav>
            <a href="/">Recent</a>
            <a href="/e/intent">Intents</a>
            <a href="/e/rule">Rules</a>
            <a href="/e/decision">Decisions</a>
            <a href="/e/action">Actions</a>
            <a href="/search">Search</a>
            <a href="/lint">Lint</a>
          </nav>
        </div>
      </header>
      <main class="container">{children}</main>
    </body>
  </html>
);
