import kleur from "kleur";

export const c = {
  ok: kleur.green,
  err: kleur.red,
  warn: kleur.yellow,
  info: kleur.cyan,
  dim: kleur.gray,
  bold: kleur.bold,
};

export function header(s: string): string {
  return c.bold(s);
}

export function checkmark(s: string): string {
  return `${c.ok("✓")} ${s}`;
}

export function cross(s: string): string {
  return `${c.err("✗")} ${s}`;
}

export function bullet(s: string): string {
  return `${c.dim("•")} ${s}`;
}

export function rule(width = 60): string {
  return c.dim("─".repeat(width));
}
