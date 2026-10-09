// Čitanje i validacija tela zahteva (zod) — deli se između API ruta i auth ruta. Poruke u šemama su ključevi
// kataloga (`E('block.titleRequired')`, server/i18n.ts); greška se prevodi na jezik zahteva u odgovoru.

import type { Context } from 'hono';
import { z } from 'zod';
import { isMsgKey } from './i18n.ts';
import type { MsgKey } from './i18n.ts';
import { badRequest } from './util.ts';

/** Poruka greške za zod šemu: ključ kataloga (`z.string(E('task.titleRequired'))`). */
export const E = (key: MsgKey) => ({ error: key });

/** Opšte poruke (ključevi) za greške koje nemaju svoju poruku u šemi. */
const genericErrorMap: z.core.$ZodErrorMap = (iss) => {
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? 'v.missing' : 'v.wrongType';
    case 'too_small':
    case 'too_big':
      return 'v.outOfRange';
    case 'unrecognized_keys':
      return 'v.unknownField';
    default:
      return 'v.invalid';
  }
};

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data, { error: genericErrorMap });
  if (r.success) return r.data;
  const iss = r.error.issues[0];
  if (!iss) throw badRequest('v.invalidData');
  const path = iss.path ?? [];
  throw badRequest(isMsgKey(iss.message) ? iss.message : 'v.invalid', {
    where: path.length ? ` (${path.join('.')})` : '',
    keys: iss.code === 'unrecognized_keys' ? iss.keys.join(', ') : '',
  });
}

/** Telo zahteva kao JSON; prazno telo = {}. */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('request.badJson');
  }
}

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  return parse(schema, await readJson(c));
}
