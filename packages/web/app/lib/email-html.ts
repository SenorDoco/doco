// The HTML every email Doco sends is wrapped in: the site's look, torre.ai's
// #f3f2ee background and its face, Merriweather. Mail clients take inline
// styles and hex colors only, so the site's palette (app.css) is restated here
// in hex. Most clients (Gmail, Outlook) won't load the web font and fall back
// to Georgia; Apple Mail loads it. Pure.

const BACKGROUND = "#f3f2ee"; // --color-background
const FOREGROUND = "#171612"; // --color-foreground
const INPUT = "#e9e8e4"; // --color-input
const BORDER = "#c3c2be"; // --color-border over the background
const PRIMARY = "#9c44a5"; // --color-primary
const SERIF = "Merriweather,Georgia,'Times New Roman',serif";
const MONO = "'Ubuntu Mono',ui-monospace,Menlo,Consolas,monospace";
const FONTS =
  "https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;1,400&family=Ubuntu+Mono&display=swap";

/** A paragraph, preformatted text, or a button. */
export type EmailBlock = string | { pre: string } | { link: string; label: string };

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
  if ("pre" in b) {
    return `<pre style="margin:0 0 16px;padding:16px;border:1px solid ${BORDER};border-radius:8px;background-color:${INPUT};white-space:pre-wrap;word-break:break-word;font-family:${MONO};font-size:13px;line-height:1.5">${escapeHtml(b.pre)}</pre>`;
  }
  return `<p style="margin:0 0 16px"><a href="${escapeHtml(b.link)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background-color:${FOREGROUND};color:#ffffff;text-decoration:none;font-weight:700">${escapeHtml(b.label)}</a></p>`;
}

/** A whole email document: the blocks in a 600px column on the site's background. */
export function emailHtml(blocks: EmailBlock[]): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<link href="${FONTS}" rel="stylesheet"></head>`,
    `<body style="margin:0;padding:0;background-color:${BACKGROUND}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BACKGROUND}" style="background-color:${BACKGROUND}"><tr><td style="padding:32px 16px">`,
    `<div style="max-width:600px;margin:0 auto;font-family:${SERIF};font-size:15px;line-height:1.6;color:${FOREGROUND}">`,
    blocks.map(block).join("\n"),
    "</div></td></tr></table></body></html>",
  ].join("\n");
}
