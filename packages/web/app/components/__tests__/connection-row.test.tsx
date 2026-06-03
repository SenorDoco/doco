import { ArrowRight } from "lucide-react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CONNECTION_ACTION_SECONDARY, ConnectionList, ConnectionRow } from "../integrations-shell";

function render(node: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("ConnectionRow / ConnectionList", () => {
  it("renders a connection as title + detail + a standardized action button", () => {
    const html = render(
      <ConnectionList>
        <ConnectionRow
          title="Torre.ai"
          detail="Installed Jun 3, 2026"
          action={{ label: "Set defaults", href: "/integrations/slack/setup", icon: ArrowRight }}
        />
      </ConnectionList>,
    );

    expect(html).toContain("Torre.ai");
    expect(html).toContain("Installed Jun 3, 2026");
    expect(html).toContain("Set defaults");
    // the action uses the single shared secondary-button class everywhere
    expect(html).toContain(CONNECTION_ACTION_SECONDARY);
    // flush divider list — never the nested bordered box the Slack card used
    expect(html).toContain('<ul class="divide-y divide-border">');
    expect(html).not.toContain("divide-y divide-border rounded-md");
  });

  it("links the title when titleHref is given, plain text otherwise", () => {
    const linked = render(
      <ConnectionRow
        title="torre-prs"
        titleHref="/torre-prs/integrations"
        detail="4 GitHub repos connected"
      />,
    );
    expect(linked).toContain('href="/torre-prs/integrations"');

    const plain = render(<ConnectionRow title="Torre.ai" detail="Installed" />);
    expect(plain).toContain(">Torre.ai<");
    expect(plain).not.toContain('href="');
  });

  it("renders children beneath the row (e.g. a nested per-Doco rollup)", () => {
    const html = render(
      <ConnectionRow
        title="acme"
        titleHref="/workspaces/acme/integrations"
        detail="2 Docos with connections"
      >
        <ul className="mt-2">
          <li>nested-doco-entry</li>
        </ul>
      </ConnectionRow>,
    );
    expect(html).toContain("nested-doco-entry");
  });
});
