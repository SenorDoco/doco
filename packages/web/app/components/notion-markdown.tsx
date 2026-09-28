// A mirrored Notion page's enhanced Markdown, rendered as React elements
// from the tree lib/notion-markdown-blocks.ts parses — so a page's text is
// only ever text. `hrefFor` maps a Notion URL to the reader's own link when
// the target is mirrored; links elsewhere open in a new tab.
import { Database, FileText, Paperclip } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import {
  type NotionBlock,
  type NotionInline,
  type NotionListItem,
  parseNotionMarkdown,
} from "~/lib/notion-markdown-blocks";

const SAFE_HREF_RE = /^(https?:\/\/|mailto:|[/?#])/i;
// Notion-hosted files are served through signed URLs that expire within the
// hour (the copy keeps them unsigned), so they link out rather than embed.
const NOTION_HOSTED_RE =
  /^(https?:\/\/[^/]*(amazonaws\.com|notion-static\.com|notion\.so)\/|attachment:)/i;

const LINK_CLASS = "font-medium text-primary underline-offset-2 hover:underline";

export function NotionMarkdown({
  markdown,
  hrefFor,
}: {
  markdown: string;
  hrefFor?: (href: string) => string;
}) {
  const blocks = useMemo(() => parseNotionMarkdown(markdown), [markdown]);
  const resolve = hrefFor ?? ((href: string) => href);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-foreground">
      {blocks.map((block, i) => (
        <Block key={`${block.type}-${i}`} block={block} resolve={resolve} />
      ))}
    </div>
  );
}

type Resolve = (href: string) => string;

function Anchor({
  href,
  resolve,
  children,
}: {
  href: string;
  resolve: Resolve;
  children: ReactNode;
}) {
  const target = resolve(href);
  if (!SAFE_HREF_RE.test(target)) return <span>{children}</span>;
  if (target.startsWith("?") || target.startsWith("/")) {
    return (
      <Link to={target} className={LINK_CLASS}>
        {children}
      </Link>
    );
  }
  return (
    <a href={target} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

function embeddableImage(src: string): boolean {
  return /^https?:\/\//i.test(src) && !NOTION_HOSTED_RE.test(src);
}

function Block({ block, resolve }: { block: NotionBlock; resolve: Resolve }) {
  switch (block.type) {
    case "heading": {
      const className =
        block.level === 1
          ? "mt-4 text-lg font-semibold"
          : block.level === 2
            ? "mt-3 text-base font-semibold"
            : "mt-2 text-sm font-semibold";
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return (
        <Tag className={className}>
          <Inlines inlines={block.children} resolve={resolve} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="break-words">
          <Inlines inlines={block.children} resolve={resolve} />
        </p>
      );
    case "list":
      return <List block={block} resolve={resolve} />;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-input p-3 text-xs">
          <code>{block.text}</code>
        </pre>
      );
    case "equation":
      return (
        <pre className="overflow-x-auto rounded-md bg-input p-3 font-mono text-xs">
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
          <Blocks blocks={block.children} resolve={resolve} />
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            {block.header.length > 0 ? (
              <thead>
                <tr>
                  {block.header.map((cell, i) => (
                    <th
                      key={`${cell.length}-${i}`}
                      className="border border-border bg-input/50 px-2 py-1 text-left"
                    >
                      <Inlines inlines={cell} resolve={resolve} />
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${row.length}-${r}`}>
                  {row.map((cell, i) => (
                    <td
                      key={`${cell.length}-${i}`}
                      className="border border-border px-2 py-1 align-top"
                    >
                      <Inlines inlines={cell} resolve={resolve} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout":
      return (
        <div className="flex gap-2 rounded-md border border-border bg-input/50 p-3">
          {block.icon ? (
            /^https?:\/\//i.test(block.icon) ? (
              embeddableImage(block.icon) ? (
                <img src={block.icon} alt="" className="h-5 w-5 shrink-0" />
              ) : null
            ) : (
              <span aria-hidden className="shrink-0">
                {block.icon}
              </span>
            )
          ) : null}
          <div className="min-w-0 flex-1 space-y-2">
            <Blocks blocks={block.children} resolve={resolve} />
          </div>
        </div>
      );
    case "details":
      return (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer font-semibold">
            <Inlines inlines={block.summary} resolve={resolve} />
          </summary>
          <div className="mt-2 space-y-2">
            <Blocks blocks={block.children} resolve={resolve} />
          </div>
        </details>
      );
    case "columns":
      return (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${block.columns.length}, minmax(0, 1fr))` }}
        >
          {block.columns.map((column, i) => (
            <div key={`${column.length}-${i}`} className="min-w-0 space-y-2">
              <Blocks blocks={column} resolve={resolve} />
            </div>
          ))}
        </div>
      );
    case "child": {
      const Icon = block.kind === "database" ? Database : FileText;
      return (
        <p>
          <Anchor href={block.href} resolve={resolve}>
            <Icon aria-hidden className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
            {block.title || "Untitled"}
          </Anchor>
        </p>
      );
    }
    case "file":
      if (block.kind === "image" && block.src && embeddableImage(block.src)) {
        return (
          <img
            src={block.src}
            alt={block.label === "image" ? "" : block.label}
            loading="lazy"
            className="max-h-96 max-w-full rounded-md"
          />
        );
      }
      return (
        <p className="text-xs">
          <Paperclip aria-hidden className="mr-1 inline h-3 w-3 align-text-bottom" />
          {block.src ? (
            <Anchor href={block.src} resolve={resolve}>
              {block.label}
            </Anchor>
          ) : (
            block.label
          )}
        </p>
      );
    case "unknown":
      return (
        <p className="text-xs italic text-muted-foreground">
          {block.alt
            ? `A ${block.alt.replace(/_/g, " ")} block Notion did not render`
            : "A block Notion did not render"}
          {block.href ? (
            <>
              {" "}
              <Anchor href={block.href} resolve={resolve}>
                (in Notion)
              </Anchor>
            </>
          ) : null}
        </p>
      );
  }
}

function Blocks({ blocks, resolve }: { blocks: NotionBlock[]; resolve: Resolve }) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={`${block.type}-${i}`} block={block} resolve={resolve} />
      ))}
    </>
  );
}

function List({
  block,
  resolve,
}: {
  block: Extract<NotionBlock, { type: "list" }>;
  resolve: Resolve;
}) {
  const todo = block.items.some((item) => item.checked !== null);
  const className = todo
    ? "space-y-1 pl-1"
    : block.ordered
      ? "list-decimal space-y-1 pl-5"
      : "list-disc space-y-1 pl-5";
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag className={className}>
      {block.items.map((item, i) => (
        <li key={`${item.checked}-${i}`}>
          <ListItem item={item} resolve={resolve} />
        </li>
      ))}
    </Tag>
  );
}

function ListItem({ item, resolve }: { item: NotionListItem; resolve: Resolve }) {
  const [first, ...rest] = item.children;
  const tight = first?.type === "paragraph";
  return (
    <>
      {item.checked !== null ? (
        <input
          type="checkbox"
          checked={item.checked}
          readOnly
          disabled
          aria-label={item.checked ? "Done" : "To do"}
          className="mr-1.5 align-middle"
        />
      ) : null}
      {tight ? <Inlines inlines={first.children} resolve={resolve} /> : null}
      {(tight ? rest : item.children).length > 0 ? (
        <div className="mt-1 space-y-2">
          <Blocks blocks={tight ? rest : item.children} resolve={resolve} />
        </div>
      ) : null}
    </>
  );
}

function Inlines({ inlines, resolve }: { inlines: NotionInline[]; resolve: Resolve }) {
  return (
    <>
      {inlines.map((inline, i) => (
        <Inline key={`${inline.type}-${i}`} inline={inline} resolve={resolve} />
      ))}
    </>
  );
}

function Inline({ inline, resolve }: { inline: NotionInline; resolve: Resolve }) {
  switch (inline.type) {
    case "text":
      return <>{inline.text}</>;
    case "strong":
      return (
        <strong>
          <Inlines inlines={inline.children} resolve={resolve} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines inlines={inline.children} resolve={resolve} />
        </em>
      );
    case "strike":
      return (
        <s>
          <Inlines inlines={inline.children} resolve={resolve} />
        </s>
      );
    case "underline":
      return (
        <u>
          <Inlines inlines={inline.children} resolve={resolve} />
        </u>
      );
    case "code":
      return <code className="rounded bg-input px-1 py-0.5 text-xs">{inline.text}</code>;
    case "link":
      return (
        <Anchor href={inline.href} resolve={resolve}>
          <Inlines inlines={inline.children} resolve={resolve} />
        </Anchor>
      );
    case "image":
      return embeddableImage(inline.src) ? (
        <img
          src={inline.src}
          alt={inline.alt}
          loading="lazy"
          className="max-h-96 max-w-full rounded-md"
        />
      ) : (
        <Anchor href={inline.src} resolve={resolve}>
          {inline.alt || "image"}
        </Anchor>
      );
    case "mention":
      return (
        <Anchor href={inline.href} resolve={resolve}>
          {inline.label}
        </Anchor>
      );
    case "user":
      return <span className="font-semibold">@{inline.name}</span>;
    case "date":
      return (
        <time dateTime={inline.start} className="rounded bg-input px-1 text-xs">
          {inline.end ? `${inline.start} → ${inline.end}` : inline.start}
        </time>
      );
    case "break":
      return <br />;
  }
}
