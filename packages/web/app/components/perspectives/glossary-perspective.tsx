// Glossary perspective — the Doco's terminology rendered as a printed
// dictionary page. Decisions become headword entries; the layout leans
// into the lexicon metaphor on purpose: serif type, a faux pronunciation
// respelling, guide words in the running head, an A–Z thumb index, and a
// two-column text flow with drop-cap letter dividers.
//
// All chrome (border, background, fullscreen + lifecycle overlays) is
// owned by the PerspectiveFrame; this component only paints the page.

import { useCallback, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { GlossaryEntry, GlossaryPerspectiveData } from "~/lib/glossary-perspective.server";

interface GlossaryPerspectiveProps {
  data: GlossaryPerspectiveData;
  /** Doco handle, styled as the dictionary's title in the masthead. */
  title: string;
  visibleLifecycles?: Set<string>;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// Warm aged-paper wash + ink tones, layered over the frame's card bg so
// the perspective reads like a printed page without fighting the theme.
const PAPER = "oklch(0.972 0.018 86)";
const INK = "oklch(0.27 0.03 60)";
const INK_SOFT = "oklch(0.46 0.035 60)";
const RULE = "oklch(0.27 0.03 60 / 28%)";

export function GlossaryPerspective({ data, title, visibleLifecycles }: GlossaryPerspectiveProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const groups = useMemo(() => {
    if (!visibleLifecycles) return data.groups;
    return data.groups
      .map((group) => ({
        ...group,
        entries: group.entries.filter((e) => visibleLifecycles.has(e.lifecycle)),
      }))
      .filter((group) => group.entries.length > 0);
  }, [data.groups, visibleLifecycles]);

  const presentLetters = useMemo(() => new Set(groups.map((g) => g.letter)), [groups]);
  const hasHash = presentLetters.has("#");

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const firstWord = flat[0]?.headword ?? null;
  const lastWord = flat[flat.length - 1]?.headword ?? null;

  const jumpTo = useCallback((letter: string) => {
    const el = sectionRefs.current.get(letter);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (flat.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center font-serif"
        style={{ backgroundColor: PAPER, color: INK }}
      >
        <p className="text-5xl" style={{ fontFamily: "var(--font-display)" }}>
          ❧
        </p>
        <p className="text-lg" style={{ fontFamily: "var(--font-display)" }}>
          The pages are blank.
        </p>
        <p className="max-w-md text-sm italic" style={{ color: INK_SOFT }}>
          No terms have been defined yet. Capture a Decision — its{" "}
          <span className="font-semibold not-italic">chosen</span> term becomes the headword and its
          prose the definition — and it will be set in type here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 font-serif" style={{ backgroundColor: PAPER, color: INK }}>
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-y-auto px-6 pb-16 pt-12 lg:px-12"
        style={{
          backgroundImage: "radial-gradient(oklch(0.27 0.03 60 / 3%) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
        <div className="mx-auto max-w-5xl">
          <Masthead
            title={title}
            count={data.stats.entries}
            firstWord={firstWord}
            lastWord={lastWord}
          />

          <div
            className="mt-6 columns-1 gap-10 lg:columns-2"
            style={{ columnRule: `1px solid ${RULE}` }}
          >
            {groups.map((group) => (
              <section
                key={group.letter}
                ref={(el) => {
                  if (el) sectionRefs.current.set(group.letter, el);
                  else sectionRefs.current.delete(group.letter);
                }}
              >
                <LetterDivider letter={group.letter} />
                {group.entries.map((entry) => (
                  <EntryView key={entry.id} entry={entry} />
                ))}
              </section>
            ))}
          </div>

          <p
            className="mt-10 border-t pt-3 text-center text-[11px] italic"
            style={{ borderColor: RULE, color: INK_SOFT }}
          >
            fin · {data.stats.entries} entries · {data.stats.defined} defined ·{" "}
            {data.stats.withAliases} with aliases
            {data.stats.drafting > 0 ? ` · ${data.stats.drafting} in draft` : ""}
          </p>
        </div>
      </div>

      <ThumbIndex present={presentLetters} hasHash={hasHash} onJump={jumpTo} />
    </div>
  );
}

function Masthead({
  title,
  count,
  firstWord,
  lastWord,
}: {
  title: string;
  count: number;
  firstWord: string | null;
  lastWord: string | null;
}) {
  return (
    <header>
      {firstWord && lastWord ? (
        <div
          className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.18em]"
          style={{ color: INK_SOFT }}
        >
          <span>{firstWord}</span>
          <span className="not-italic">guide words</span>
          <span>{lastWord}</span>
        </div>
      ) : null}
      <div className="mt-1 border-y-2 py-3 text-center" style={{ borderColor: INK }}>
        <h1
          className="text-3xl leading-none tracking-tight lg:text-4xl"
          style={{ fontFamily: "var(--font-display)", color: INK }}
        >
          {title}
        </h1>
        <p className="mt-2 text-sm" style={{ color: INK_SOFT }}>
          <span className="italic">glos·sa·ry</span>{" "}
          <span className="tabular-nums">/ ˈɡlɒs · ə · ri /</span>{" "}
          <span className="italic">n.</span> — a lexicon of{" "}
          <span className="font-semibold tabular-nums" style={{ color: INK }}>
            {count}
          </span>{" "}
          {count === 1 ? "term" : "terms"}, set in alphabetical order
        </p>
      </div>
    </header>
  );
}

function LetterDivider({ letter }: { letter: string }) {
  return (
    <div
      className="mb-3 mt-6 flex items-center gap-3 break-after-avoid-column first:mt-0"
      aria-hidden
    >
      <span
        className="leading-none"
        style={{ fontFamily: "var(--font-display)", fontSize: "2.25rem", color: INK }}
      >
        {letter}
      </span>
      <span className="h-px flex-1" style={{ backgroundColor: RULE }} />
    </div>
  );
}

function EntryView({ entry }: { entry: GlossaryEntry }) {
  return (
    <article
      className="mb-4 break-inside-avoid"
      style={{ textIndent: 0 }}
      data-neuron-id={entry.id}
      data-glossary-headword={entry.headword}
    >
      <p className="leading-snug" style={{ textIndent: "-1em", paddingLeft: "1em" }}>
        <Link
          to={entry.href}
          className="font-bold no-underline hover:underline"
          style={{ color: INK, fontSize: "1.05rem" }}
        >
          {entry.headword}
        </Link>
        {entry.pronunciation ? (
          <span className="ml-1.5 text-[0.8rem]" style={{ color: INK_SOFT }}>
            {entry.pronunciation}
          </span>
        ) : null}{" "}
        <span className="text-[0.85rem] italic" style={{ color: INK_SOFT }}>
          {entry.tag}
        </span>
        {entry.lifecycle !== "accepted" ? (
          <span
            className="ml-1.5 align-[0.1em] text-[9px] uppercase tracking-wider"
            style={{ color: INK_SOFT }}
          >
            [{entry.lifecycle}]
          </span>
        ) : null}{" "}
        {entry.question ? (
          <span className="text-[0.9rem] italic" style={{ color: INK_SOFT }}>
            {entry.question}
            {/[.?!]$/.test(entry.question) ? "" : "."}{" "}
          </span>
        ) : null}
        {renderSenses(entry.senses)}
        {entry.source ? (
          <span className="text-[0.82rem] italic" style={{ color: INK_SOFT }}>
            {" "}
            — {entry.source}
          </span>
        ) : null}
      </p>
      {entry.alternatives.length > 0 ? (
        <p className="mt-0.5 pl-[1em] text-[0.85rem]" style={{ color: INK_SOFT }}>
          <span className="italic">also</span>{" "}
          {entry.alternatives.map((alt, i) => (
            <span key={`${alt.name}-${i}`}>
              {i > 0 ? ", " : ""}
              <span
                title={alt.note ?? undefined}
                style={alt.deprecated ? { textDecoration: "line-through" } : undefined}
              >
                {alt.name}
              </span>
              {alt.deprecated ? (
                <span className="ml-0.5 text-[9px] uppercase tracking-wider">dep.</span>
              ) : null}
            </span>
          ))}
        </p>
      ) : null}
    </article>
  );
}

function renderSenses(senses: string[]) {
  if (senses.length === 0) {
    return <span className="italic">(definition pending.)</span>;
  }
  if (senses.length === 1) {
    return <span style={{ color: INK }}>{senses[0]}</span>;
  }
  return (
    <span style={{ color: INK }}>
      {senses.map((sense, i) => (
        <span key={`${i}-${sense.slice(0, 24)}`}>
          {i > 0 ? "  " : ""}
          <span className="font-semibold" style={{ color: INK_SOFT }}>
            {i + 1}.
          </span>{" "}
          {sense}
        </span>
      ))}
    </span>
  );
}

function ThumbIndex({
  present,
  hasHash,
  onJump,
}: {
  present: Set<string>;
  hasHash: boolean;
  onJump: (letter: string) => void;
}) {
  return (
    <nav
      aria-label="Jump to letter"
      className="flex w-9 shrink-0 flex-col items-stretch justify-center border-l py-2 text-center"
      style={{ borderColor: RULE, backgroundColor: "oklch(0.95 0.022 86)" }}
    >
      {ALPHABET.map((letter) => {
        const active = present.has(letter);
        return (
          <button
            key={letter}
            type="button"
            disabled={!active}
            onClick={() => onJump(letter)}
            className={`leading-tight transition-colors ${
              active ? "cursor-pointer hover:bg-black/5" : "cursor-default"
            }`}
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "0.72rem",
              color: active ? INK : "oklch(0.27 0.03 60 / 28%)",
              fontWeight: active ? 700 : 400,
            }}
            title={active ? `Jump to ${letter}` : `No ${letter} terms`}
          >
            {letter}
          </button>
        );
      })}
      {hasHash ? (
        <button
          type="button"
          onClick={() => onJump("#")}
          className="cursor-pointer leading-tight hover:bg-black/5"
          style={{ fontFamily: "var(--font-display)", fontSize: "0.72rem", color: INK }}
          title="Jump to non-alphabetic terms"
        >
          #
        </button>
      ) : null}
    </nav>
  );
}
