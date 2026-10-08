// Čitanje i validacija tela zahteva (zod) sa porukama na srpskom — deli se između API ruta i auth ruta.

import type { Context } from 'hono';
import { z } from 'zod';
import { badRequest } from './util.ts';

/** Opšte poruke na srpskom za greške koje nemaju svoju poruku u šemi. */
const srErrorMap: z.core.$ZodErrorMap = (iss) => {
  const path = iss.path ?? [];
  const where = path.length ? ` (${path.join('.')})` : '';
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? `Nedostaje vrednost${where}.` : `Pogrešan tip vrednosti${where}.`;
    case 'too_small':
    case 'too_big':
      return `Vrednost je van dozvoljenog opsega${where}.`;
    case 'unrecognized_keys':
      return `Nepoznato polje: ${iss.keys.join(', ')}.`;
    default:
      return `Neispravna vrednost${where}.`;
  }
};

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data, { error: srErrorMap });
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'Neispravni podaci.');
  return r.data;
}

/** Telo zahteva kao JSON; prazno telo = {}. */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Neispravan JSON u zahtevu.');
  }
}

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  return parse(schema, await readJson(c));
}
