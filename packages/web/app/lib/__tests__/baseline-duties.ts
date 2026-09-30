import { expect } from "vitest";

// Alexander, 2026-09-30: after loading context, an agent records the chat in
// the workspace's Agents chats Doco, then documents each decision in the
// decisions Doco that fits its kind. Every agent surface states the duties in
// that order, and tests hold each one to this check.
export function expectBaselineDuties(text: string): void {
  const flat = text.replace(/\s+/g, " ");
  const load = flat.indexOf("Load context first");
  const record = flat.indexOf("Record the conversation");
  const decide = flat.indexOf("Document every decision");
  expect(load, "Load context first").toBeGreaterThanOrEqual(0);
  expect(record, "Record the conversation comes second").toBeGreaterThan(load);
  expect(decide, "Document every decision comes third").toBeGreaterThan(record);
  expect(flat.slice(record, decide)).toContain("Agents chats Doco");
  for (const doco of ["Product decisions", "Design decisions", "Architectural decisions"]) {
    expect(flat.slice(decide), doco).toContain(doco);
  }
}
