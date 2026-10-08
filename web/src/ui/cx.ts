/** Spaja CSS klase, preskače false/null/undefined. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}
