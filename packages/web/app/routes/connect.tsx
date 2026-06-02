// GET /connect — human-facing guide for connecting an AI client to Doco
// over the hosted MCP server. The machine-readable equivalent is /llms.txt.

import { Link, useLoaderData } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";

export function loader({ request }: { request: Request }) {
  const baseUrl = new URL(request.url).origin;
  return { baseUrl };
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-input px-1 py-0.5 font-mono">{children}</code>;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md bg-input px-3 py-2 font-mono text-xs">
      <code>{children}</code>
    </pre>
  );
}

export default function ConnectPage() {
  const { baseUrl } = useLoaderData<typeof loader>();
  const mcpUrl = `${baseUrl}/mcp`;
  return (
    <>
      <SiteHeader />
      <SingleColumnPageMain className="py-8">
        <h1 className="text-2xl font-semibold">Connect a client to Doco</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Doco hosts a remote MCP server at <Code>{mcpUrl}</Code>. Point any MCP-capable client at
          it — the client runs the OAuth approval for you and carries the token from then on. The
          machine-readable version of this page is{" "}
          <Link to="/llms.txt" className="underline hover:opacity-80">
            /llms.txt
          </Link>
          .
        </p>

        <div className="mt-6 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>claude.ai, Claude mobile, Cursor</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Settings → Connectors → Add custom connector, and paste the URL:
              </p>
              <CodeBlock>{mcpUrl}</CodeBlock>
              <p className="mt-2 text-sm text-muted-foreground">
                Approve the OAuth prompt and choose which Docos to grant.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Claude Desktop, Claude Code</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                These bridge to remote MCP with <Code>mcp-remote</Code>. Claude Code:
              </p>
              <CodeBlock>{`claude mcp add doco -- npx -y mcp-remote ${mcpUrl}`}</CodeBlock>
              <p className="mt-3 text-sm text-muted-foreground">
                Claude Desktop — add to <Code>claude_desktop_config.json</Code>:
              </p>
              <CodeBlock>{`{
  "mcpServers": {
    "doco": { "command": "npx", "args": ["-y", "mcp-remote", "${mcpUrl}"] }
  }
}`}</CodeBlock>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>ChatGPT &amp; other MCP clients</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Add a connector / custom MCP server with the URL:
              </p>
              <CodeBlock>{mcpUrl}</CodeBlock>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What you get</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                The connector exposes <Code>doco_search</Code> — pass a <Code>query</Code> and a
                Doco <Code>handle</Code>. Auth is OAuth 2.1 (PKCE + dynamic client registration); an
                unauthenticated request returns a 401 whose <Code>WWW-Authenticate</Code> header
                points at <Code>{`${baseUrl}/.well-known/oauth-protected-resource`}</Code> so the
                client discovers the rest. No repo or local files needed.
              </p>
            </CardContent>
          </Card>
        </div>
      </SingleColumnPageMain>
    </>
  );
}
