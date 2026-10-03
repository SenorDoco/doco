// The HTML every email Doco sends is wrapped in: the site's look, torre.ai's
// #f3f2ee background and its face, Merriweather, and the site's one clay as
// far as mail allows. Mail clients take inline styles and hex colors only, so
// the palette (app.css) is restated here in hex, and the three roles are
// restated as inline box-shadows: the column is a slab, the button a purple
// key, preformatted text a well, and nothing has an outline. Apple Mail, iOS
// Mail and Gmail honour the shadows; Outlook drops them and shows the same
// email flat on the page. Most clients (Gmail, Outlook) won't load the web
// fonts and fall back to Georgia and their own monospace; Apple Mail loads
// them. Pure.

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
const MONO = "'Ubuntu Mono',ui-monospace,Menlo,Consolas,monospace";
const FONTS =
  "https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap";
// The site's own Ubuntu Mono, drawn 120% so it stands as tall as Merriweather
// (the @font-face rules in app.css say why).
const MONO_FACE =
  "@font-face{font-family:'Ubuntu Mono';src:url(https://doco.to/fonts/ubuntu-mono-400.woff2) format('woff2');size-adjust:120%}";

export type EmailBlock =
  /** A paragraph. */
  | string
  /** A section's title. */
  | { heading: string }
  /** A bulleted list. */
  | { list: string[] }
  /** Preformatted text, such as the message to send an agent. */
  | { pre: string }
  /** A button. */
  | { link: string; label: string }
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
    return `<p style="margin:24px 0 8px;font-weight:700">${escapeHtml(b.heading)}</p>`;
  }
  if ("list" in b) {
    const items = b.list.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
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
  return `<p style="margin:0 0 16px"><a href="${escapeHtml(b.link)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background-color:${PRIMARY};color:#ffffff;text-decoration:none;font-weight:700;box-shadow:${KEY}">${escapeHtml(b.label)}</a></p>`;
}

/** A whole email document: the blocks on a 600px slab on the site's background. */
export function emailHtml(blocks: EmailBlock[]): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<link href="${FONTS}" rel="stylesheet"><style>${MONO_FACE}</style></head>`,
    `<body style="margin:0;padding:0;background-color:${BACKGROUND}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BACKGROUND}" style="background-color:${BACKGROUND}"><tr><td style="padding:40px 16px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:600px;margin:0 auto;border-radius:12px;box-shadow:${SLAB}"><tr><td style="padding:32px 28px;font-family:${SERIF};font-size:15px;line-height:1.6;color:${FOREGROUND}">`,
    blocks.map(block).join("\n"),
    "</td></tr></table></td></tr></table></body></html>",
  ].join("\n");
}
