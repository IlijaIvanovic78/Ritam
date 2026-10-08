// Srpski oblici množine: 1 zadatak, 2–4 zadatka, 5+ zadataka (11–14 → zadataka; 21 → zadatak).

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n)) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** "3 zadatka" */
export function countOf(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

export const blocksWord = (n: number) => plural(n, 'blok', 'bloka', 'blokova');
