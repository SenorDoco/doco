// Pure tokenizers that turn note/edge dialog text into a flat list of render
// tokens: plain text, hyperlinks (markdown `[label](url)` or bare URLs), and
// code permalinks (a Reference `locator` resolved to a GitHub blob URL). The
// React layer in `linked-text.tsx` maps these tokens to anchors; keeping the
// parsing here makes it unit-testable without rendering.
import { codeLocatorGithubUrl } from "./code-locator";

export type LinkToken =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string; label: string }
  | { kind: "code"; url: string; label: string };

const TRAILING_PUNCT_RE = /[.,;:!?'")\]}>]+$/;

/**
 * Split prose into text and hyperlink tokens. Recognizes markdown
 * `[label](url)` links and bare `http(s)://…` URLs; trailing sentence
 * punctuation is peeled back off a bare URL so it stays as text.
 */
export function tokenizeProse(text: string): LinkToken[] {
  const out: LinkToken[] = [];
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>]+)/gi;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ kind: "url", url: m[2] ?? "", label: m[1] });
    } else {
      const rawUrl = m[3] ?? "";
      const trail = TRAILING_PUNCT_RE.exec(rawUrl)?.[0] ?? "";
      const url = trail ? rawUrl.slice(0, rawUrl.length - trail.length) : rawUrl;
      out.push({ kind: "url", url, label: url });
      if (trail) out.push({ kind: "text", text: trail });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/**
 * Resolve a single scalar value (a metadata/prop value, or a Reference
 * `locator`). A clean, whitespace-free value is tried as a whole-value URL,
 * then as a code permalink against `githubRepo`; anything else falls back to
 * prose tokenizing so embedded URLs still linkify.
 */
export function resolveScalarValue(value: string, githubRepo: string | null): LinkToken[] {
  const trimmed = value.trim();
  if (trimmed && !/\s/.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) return [{ kind: "url", url: trimmed, label: value }];
    const gh = codeLocatorGithubUrl(githubRepo, trimmed);
    if (gh) return [{ kind: "code", url: gh, label: value }];
  }
  return tokenizeProse(value);
}
