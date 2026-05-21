// Random greeting verb shown in the dashboard's "Good <verb>, <user>"
// header. The verbs are gerunds related to what Doco does (capturing,
// deciding, aligning, …) — playful riff on "Good morning".
//
// One verb is picked per page load. Picked server-side in the loader
// so the value is deterministic during SSR + hydration on a single
// request, even though it differs across loads.

const GREETING_VERBS = [
  "capturing",
  "documenting",
  "deciding",
  "aligning",
  "planning",
  "iterating",
  "reflecting",
  "building",
  "shipping",
  "drafting",
  "proposing",
  "reviewing",
  "authoring",
  "tracking",
  "organizing",
  "reasoning",
  "coordinating",
  "researching",
  "exploring",
  "thinking",
] as const;

export function pickGreetingVerb(): string {
  const idx = Math.floor(Math.random() * GREETING_VERBS.length);
  return GREETING_VERBS[idx] ?? "thinking";
}
