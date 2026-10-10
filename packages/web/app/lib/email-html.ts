// The HTML every email Doco sends is wrapped in: the site's look, torre.ai's
// #f3f2ee background and its face, Merriweather, and the site's one clay as
// far as mail allows. Mail clients take inline styles and hex colors only, so
// the palette (app.css) is restated here in hex, and the three roles are
// restated as inline box-shadows: the column is a slab, a button a key (purple,
// or clay with purple text), preformatted text a well, and nothing has an
// outline. Apple Mail, iOS Mail and Gmail honour the shadows; Outlook drops
// them and shows the same email flat on the page. Most clients (Gmail,
// Outlook) won't load the web fonts and fall back to Georgia and their own
// monospace; Apple Mail loads them.
//
// The activity digest is a newspaper's front page (lib/activity-digest.ts), so
// the blocks also lay one out: a masthead image, a dateline between a thin rule
// and a double one, stories under a kicker and a linked headline, section heads
// in small capitals under a rule, and columns side by side. Columns are
// inline-blocks as wide as their share of the text, so they stack when the
// text is narrower, and a media query widens them to the whole text once
// stacked (Gmail, Apple Mail); Outlook, which ignores max-width, stacks them
// too. Pure.

const BACKGROUND = "#f3f2ee"; // --color-background
const FOREGROUND = "#171612"; // --color-foreground
const MUTED = "#5c5b56"; // --color-muted-foreground
const INPUT = "#e9e8e4"; // --color-input
const PRIMARY = "#9c44a5"; // --color-primary
// --neu-slab, --neu-key and --neu-inset, with the foreground's alpha in rgba
// and the highlight as white.
const SLAB = "7px 7px 16px rgba(23,22,18,0.09),-7px -7px 16px #ffffff";
const KEY = "5px 5px 12px rgba(23,22,18,0.11),-5px -5px 12px #ffffff";
const WELL = "inset 4px 4px 9px rgba(23,22,18,0.13),inset -4px -4px 9px #ffffff";
const SERIF = "Merriweather,Georgia,'Times New Roman',serif";
/** How wide an email's text is: the 600px slab less its padding. */
export const COLUMN_WIDTH = 544;
const RULE = `1px solid ${FOREGROUND}`;
const SMALL_CAPS = "font-size:11px;line-height:1.4;letter-spacing:1px;text-transform:uppercase";
const MONO = "'Ubuntu Mono',ui-monospace,Menlo,Consolas,monospace";
const FONTS =
  "https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap";
// The site's own Ubuntu Mono, drawn 120% so it stands as tall as Merriweather
// (the @font-face rules in app.css say why).
const MONO_FACE =
  "@font-face{font-family:'Ubuntu Mono';src:url(https://doco.to/fonts/ubuntu-mono-400.woff2) format('woff2');size-adjust:120%}";
// Below the width at which the 600px slab and its margins fit, columns stack:
// each then takes the whole text.
const STACKED_COLUMNS =
  "@media (max-width:631px){.column{max-width:100%!important}.gutter{padding-right:0!important}}";

export type EmailBlock =
  /** A paragraph. */
  | string
  /** A section's head: small capitals under a thin rule. */
  | { heading: string }
  /** An image as wide as the text, such as a newspaper's masthead. */
  | { image: string; alt: string }
  /** A newspaper's dateline: small print from left to right between a thin
   *  rule and a double one. */
  | { dateline: string[] }
  /** A story: a kicker, a headline linked to it, and what it says. The lead
   *  story's headline is the biggest; any other stands under a rule. */
  | { kicker: string; headline: string; text: string; link: string; lead?: boolean }
  /** Blocks side by side, stacking on a narrow screen. */
  | { columns: EmailBlock[][] }
  /** A bulleted list; an item may end in a link, such as where it lives. */
  | { list: (string | { text: string; link: string; label: string })[] }
  /** Preformatted text, such as the message to send an agent. */
  | { pre: string }
  /** A button: a purple key, or for the action beside the main one a quiet
   *  key, the page's clay with purple text (the site's plain .neu-button). */
  | { link: string; label: string; quiet?: boolean }
  /** Numbers side by side, each above its label. */
  | { stats: { value: string; label: string }[] }
  /** Small print closing the email, with a link after it. */
  | { footer: string; link: string; label: string };

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Escaped text with each URL in it made a link. */
function paragraph(text: string): string {
  return escapeHtml(text).replace(
    /https?:\/\/[^\s,;)]+[^\s,;).:!?]/g,
    (url) => `<a href="${url}" style="color:${PRIMARY}">${url}</a>`,
  );
}

function block(b: EmailBlock): string {
  if (typeof b === "string") return `<p style="margin:0 0 16px">${paragraph(b)}</p>`;
  if ("heading" in b) {
    return `<p style="margin:24px 0 8px;padding-top:8px;border-top:${RULE};${SMALL_CAPS};font-weight:700">${escapeHtml(b.heading)}</p>`;
  }
  if ("image" in b) {
    return `<img src="${escapeHtml(b.image)}" alt="${escapeHtml(b.alt)}" width="${COLUMN_WIDTH}" style="display:block;width:100%;max-width:${COLUMN_WIDTH}px;height:auto;margin:0 auto 8px;border:0;font-size:32px;font-weight:700;text-align:center;color:${FOREGROUND}">`;
  }
  if ("dateline" in b) {
    const align = (i: number) =>
      i === 0 ? "left" : i === b.dateline.length - 1 ? "right" : "center";
    const cells = b.dateline
      .map(
        (cell, i) =>
          `<td style="padding:6px 0;${SMALL_CAPS};text-align:${align(i)}">${escapeHtml(cell)}</td>`,
      )
      .join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-top:${RULE};border-bottom:3px double ${FOREGROUND}"><tr>${cells}</tr></table>`;
  }
  if ("headline" in b) {
    const rule = b.lead ? "" : `;padding-top:12px;border-top:${RULE}`;
    const size = b.lead ? 26 : 19;
    return [
      `<div style="margin:0 0 20px${rule}">`,
      `<p style="margin:0 0 6px;${SMALL_CAPS};color:${MUTED}">${escapeHtml(b.kicker)}</p>`,
      `<p style="margin:0 0 8px;font-size:${size}px;line-height:1.25;font-weight:700"><a href="${escapeHtml(b.link)}" style="color:${FOREGROUND};text-decoration:none">${escapeHtml(b.headline)}</a></p>`,
      b.text ? `<p style="margin:0">${escapeHtml(b.text)}</p>` : "",
      "</div>",
    ].join("");
  }
  if ("columns" in b) {
    const width = Math.floor(COLUMN_WIDTH / b.columns.length);
    const columns = b.columns
      .map(
        (blocks, i) =>
          `<div class="column" style="display:inline-block;vertical-align:top;width:100%;max-width:${width}px;font-size:15px;line-height:1.6"><div class="gutter" style="padding-right:${i < b.columns.length - 1 ? 16 : 0}px">${blocks.map(block).join("\n")}</div></div>`,
      )
      .join("");
    // No size between the inline-blocks, so they fit side by side.
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:0;line-height:0">${columns}</td></tr></table>`;
  }
  if ("list" in b) {
    const items = b.list
      .map((item) =>
        typeof item === "string"
          ? `<li>${escapeHtml(item)}</li>`
          : `<li>${escapeHtml(item.text)} (<a href="${escapeHtml(item.link)}" style="color:${PRIMARY}">${escapeHtml(item.label)}</a>)</li>`,
      )
      .join("");
    return `<ul style="margin:0 0 16px;padding-left:20px">${items}</ul>`;
  }
  if ("pre" in b) {
    return `<pre style="margin:0 0 16px;padding:16px;border-radius:8px;background-color:${INPUT};box-shadow:${WELL};white-space:pre-wrap;word-break:break-word;font-family:${MONO};font-size:13px;line-height:1.5">${escapeHtml(b.pre)}</pre>`;
  }
  if ("stats" in b) {
    const cells = b.stats
      .map(
        (st) =>
          `<td style="padding:0 24px 0 0;vertical-align:top"><div style="font-size:24px;font-weight:700;line-height:1.2">${escapeHtml(st.value)}</div><div style="color:${MUTED}">${escapeHtml(st.label)}</div></td>`,
      )
      .join("");
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px"><tr>${cells}</tr></table>`;
  }
  if ("footer" in b) {
    return `<p style="margin:32px 0 0;font-size:12px;color:${MUTED}">${escapeHtml(b.footer)} <a href="${escapeHtml(b.link)}" style="color:${PRIMARY}">${escapeHtml(b.label)}</a></p>`;
  }
  const colors = b.quiet
    ? `background-color:${BACKGROUND};color:${PRIMARY}`
    : `background-color:${PRIMARY};color:#ffffff`;
  return `<p style="margin:0 0 16px"><a href="${escapeHtml(b.link)}" style="display:inline-block;padding:10px 16px;border-radius:6px;${colors};text-decoration:none;font-weight:700;box-shadow:${KEY}">${escapeHtml(b.label)}</a></p>`;
}

/** A whole email document: the blocks on a 600px slab on the site's background. */
export function emailHtml(blocks: EmailBlock[]): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<link href="${FONTS}" rel="stylesheet"><style>${MONO_FACE}${STACKED_COLUMNS}</style></head>`,
    `<body style="margin:0;padding:0;background-color:${BACKGROUND}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BACKGROUND}" style="background-color:${BACKGROUND}"><tr><td style="padding:40px 16px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:600px;margin:0 auto;border-radius:12px;box-shadow:${SLAB}"><tr><td style="padding:32px 28px;font-family:${SERIF};font-size:15px;line-height:1.6;color:${FOREGROUND}">`,
    blocks.map(block).join("\n"),
    "</td></tr></table></td></tr></table></body></html>",
  ].join("\n");
}
