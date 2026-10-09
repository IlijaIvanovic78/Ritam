// Testovi modela dana kao niza blokova (shared/blockStack.ts): operacije, scenariji korisnika, konverzije
// server ↔ niz, istorija i nasumični test sa semenom (≥ 50 000 primenjenih izmena). `npm test`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBlockStack,
  emptyHistory,
  fromBlocks,
  historyRecord,
  historyRedo,
  historyUndo,
  layoutBase,
  makeBlock,
  makeFree,
  templateBase,
  toBlocks,
  toTemplateBlocks,
} from './blockStack.ts';
import type { Anchor, BlockStackModel, ItemId, Stack, StackBlock, StackItem, StackSnapshot } from './blockStack.ts';
import { fmtClock, isValidRange } from './time.ts';
import type { Block, BlockStatus } from './types.ts';

// ---------------- Pomoćnici ----------------

/** "13:30-15:00 Deep work" / "12:00-12:30 ·free" (+ " [done]" za ocenjen blok). */
function lines(M: BlockStackModel, l: Stack): string[] {
  const st = M.startsOf(l);
  return l.map((c, i) => {
    const r = `${fmtClock(st[i])}-${fmtClock(st[i] + c.dur)}`;
    return c.kind === 'free' ? `${r} ·free` : `${r} ${c.title}${c.status === 'pending' ? '' : ` [${c.status}]`}`;
  });
}
const has = (M: BlockStackModel, l: Stack, line: string) => lines(M, l).includes(line);
const byTitle = (l: Stack, title: string, nth = 0): StackBlock => {
  const found = l.filter((c): c is StackBlock => c.kind === 'block' && c.title === title)[nth];
  assert.ok(found, `nema bloka "${title}" #${nth}`);
  return found;
};
const startOfTitle = (M: BlockStackModel, l: Stack, title: string, nth = 0) => M.startOf(l, byTitle(l, title, nth).id);
const idx = (M: BlockStackModel, l: Stack, title: string, nth = 0) => M.idxOf(l, byTitle(l, title, nth).id);
const must = <T>(v: T | null | undefined, what = 'rezultat'): T => {
  assert.ok(v != null, `${what} ne sme biti null`);
  return v as T;
};
const blk = (title: string, dur: number, status: BlockStatus = 'pending', actualMin: number | null = null, note = '', id?: ItemId) =>
  makeBlock({ id, title, dur, categoryId: 1, status, actualMin, note });

/**
 * Primer dana iz prototipa (dayStart 0): Sleep 00:00–07:00 … Reading 21:30–22:30, slobodno 12:00–12:30 i 20:00–20:30.
 * Pre 13:10 je sve ocenjeno osim Project (čeka ocenu) i Lunch (tekući).
 */
function sampleDay(M: BlockStackModel, rated = true): StackItem[] {
  const s = (st: BlockStatus): BlockStatus => (rated ? st : 'pending');
  return M.normalize([
    blk('Sleep', 420, s('done'), null, '', 1),
    blk('Morning', 60, s('done'), null, '', 2),
    blk('Emails', 60, s('partial'), rated ? 40 : null, '', 3),
    blk('Project', 150, 'pending', null, '', 4),
    blk('Walk', 30, s('skipped'), null, rated ? 'Rain' : '', 5),
    makeFree(30),
    blk('Lunch', 60, 'pending', null, '', 6),
    blk('Deep work', 180, 'pending', null, '', 7),
    blk('Break', 30, 'pending', null, '', 8),
    blk('Meeting', 60, 'pending', null, '', 9),
    blk('Study', 120, 'pending', null, '', 10),
    makeFree(30),
    blk('Dinner', 60, 'pending', null, '', 11),
    blk('Reading', 60, 'pending', null, '', 12),
  ]);
}

const serverBlock = (id: number, start: number, end: number, title: string, extra: Partial<Block> = {}): Block => ({
  id,
  date: '2026-10-09',
  start,
  end,
  title,
  categoryId: null,
  status: 'pending',
  actualMin: null,
  note: '',
  ...extra,
});

// ---------------- Osnove ----------------

describe('normalize i okvir', () => {
  test('spaja susedna slobodna vremena, izbacuje prazne stavke, dopunjava dan do 24h', () => {
    const M = createBlockStack(0);
    const l = M.normalize([makeFree(30), makeFree(15), blk('A', 60), makeFree(0), blk('B', 30)]);
    assert.deepEqual(lines(M, l), ['00:00-00:45 ·free', '00:45-01:45 A', '01:45-02:15 B', '02:15-00:00 ·free']);
    assert.equal(M.total(l), 1440);
  });

  test('bez slobodnog vremena na kraju kad je dan pun ili prepun', () => {
    const M = createBlockStack(0);
    const l = M.normalize([blk('A', 1000), blk('B', 500), makeFree(30)]);
    assert.equal(l.length, 2);
    assert.equal(M.total(l), 1500);
    assert.deepEqual(M.overflowing(l), []);
  });

  test('dayStart 60: stavke se slažu od 01:00', () => {
    const M = createBlockStack(60);
    const l = M.normalize([blk('Sleep', 420), blk('Work', 480)]);
    assert.deepEqual(lines(M, l), ['01:00-08:00 Sleep', '08:00-16:00 Work', '16:00-01:00 ·free']);
    assert.deepEqual(M.frame, { start: 60, end: 1500 });
  });
});

// ---------------- Scenariji korisnika ----------------

describe('scenariji korisnika', () => {
  test('podeli 3h na 1h30 + 1h30 i stavi drugu polovinu pre drugog bloka', () => {
    const M = createBlockStack(0);
    let l = M.normalize([blk('Work', 180, 'pending', null, '', 1), blk('Rest', 60, 'pending', null, '', 2), blk('Training', 60, 'pending', null, '', 3)]);
    l = M.normalize([makeFree(540), ...l]);
    const work = byTitle(l, 'Work');
    const cuts = must(M.cuts15(work.dur, 2));
    assert.deepEqual(cuts, [90]);
    const r = must(M.opSplit(l, work.id, cuts));
    l = r.list;
    assert.deepEqual(lines(M, l).slice(1, 5), ['09:00-10:30 Work', '10:30-12:00 Work', '12:00-13:00 Rest', '13:00-14:00 Training']);
    // Druga polovina ispred bloka Training.
    l = must(M.opMoveTo(l, r.ids[1], idx(M, l, 'Training'), null));
    assert.deepEqual(lines(M, l).slice(1, 5), ['09:00-10:30 Work', '10:30-11:30 Rest', '11:30-13:00 Work', '13:00-14:00 Training']);
    assert.equal(M.total(l), 1440);
  });

  test('Deep work 3h: polovina ispred Meeting-a (prevlačenjem i preko "Premesti")', () => {
    const M = createBlockStack(0);
    const A = M.anchor(13 * 60 + 10);
    let l = sampleDay(M);
    const deep = byTitle(l, 'Deep work');
    const r = must(M.opSplit(l, deep.id, must(M.cuts15(deep.dur, 2))));
    l = r.list;
    assert.ok(has(M, l, '13:30-15:00 Deep work') && has(M, l, '15:00-16:30 Deep work'));
    const moved = must(M.opMoveTo(l, r.ids[1], idx(M, l, 'Meeting'), A));
    assert.ok(M.pastOk(l, moved, A));
    for (const line of ['13:30-15:00 Deep work', '15:00-15:30 Break', '15:30-17:00 Deep work', '17:00-18:00 Meeting']) {
      assert.ok(has(M, moved, line), line);
    }
    // Isti rezultat bez prevlačenja: mesto "Ovde · od 15:30" u režimu Premesti.
    const spot = M.moveTargets(l, r.ids[1], A).find((t) => t.kind === 'seam' && t.start === 15 * 60 + 30);
    assert.deepEqual(lines(M, must(spot, 'mesto od 15:30').next), lines(M, moved));
    // Samo Break je pomeren (pored samog bloka).
    assert.deepEqual(M.movedBlocks(l, moved, r.ids[1]).map((m) => m.id), [byTitle(l, 'Break').id]);
  });

  test('podeli 2h na 4 × 30m i rasporedi delove', () => {
    const M = createBlockStack(0);
    const A = M.anchor(13 * 60 + 10);
    let l = sampleDay(M);
    const study = byTitle(l, 'Study');
    const cuts = must(M.cuts15(study.dur, 4));
    assert.deepEqual(cuts, [30, 60, 90]);
    const r = must(M.opSplit(l, study.id, cuts));
    l = r.list;
    for (const t of ['18:00', '18:30', '19:00', '19:30']) assert.ok(lines(M, l).some((x) => x.startsWith(t) && x.endsWith('Study')), t);
    const pieces = l.filter((c): c is StackBlock => c.kind === 'block' && c.title === 'Study');
    assert.ok(pieces.every((p) => p.status === 'pending' && p.note === '' && p.categoryId === study.categoryId));
    assert.equal(new Set(pieces.map((p) => p.id)).size, 4);

    // 4. deo u slobodno vreme na kraju dana (22:30); Reading se ne pomera.
    const tail = l[l.length - 1];
    l = must(M.opPlace(l, r.ids[3], tail.id, 0, A));
    assert.ok(has(M, l, '22:30-23:00 Study') && has(M, l, '21:30-22:30 Reading'));
    // 1. deo ispred Meeting-a.
    l = must(M.opMoveTo(l, r.ids[0], idx(M, l, 'Meeting'), A));
    assert.ok(has(M, l, '17:00-17:30 Study') && has(M, l, '17:30-18:30 Meeting'));
    // 3. deo u slobodno vreme od 20:00: staro mesto postaje slobodno, Dinner ostaje.
    const gap = must(M.freeAt(l, 19 * 60 + 45));
    const gapStart = must(M.startOf(l, gap.id));
    l = must(M.opPlace(l, r.ids[2], gap.id, 20 * 60 - gapStart, A));
    assert.ok(has(M, l, '20:00-20:30 Study') && has(M, l, '19:00-20:00 ·free') && has(M, l, '20:30-21:30 Dinner'), lines(M, l).join('\n'));
    assert.equal(M.total(l), 1440);
  });

  test('ubaci imenovan blok usred dana: gura do prvog slobodnog vremena', () => {
    const M = createBlockStack(0);
    const A = M.anchor(13 * 60 + 10);
    const l = sampleDay(M);
    // "+" (bez izbora) posle tekućeg bloka Lunch.
    const spec = M.defaultInsertSpec(l, A);
    assert.deepEqual(spec, { mode: 'seam', at: idx(M, l, 'Deep work') });
    const prep = must(M.prepareInsert(l, spec, A));
    assert.equal(prep.dur, 60);
    const training = makeBlock({ title: 'Training', dur: prep.dur, categoryId: 3 });
    const next = must(M.opInsertAt(l, prep.spec, training));
    assert.ok(M.pastOk(l, next, A));
    assert.ok(has(M, next, '13:30-14:30 Training') && has(M, next, '14:30-17:30 Deep work'));
    // Slobodno vreme 20:00–20:30 upija 30 min, ostatak upija kraj dana.
    assert.ok(has(M, next, '21:00-22:00 Dinner') && has(M, next, '22:00-23:00 Reading') && has(M, next, '23:00-00:00 ·free'));
    const moved = M.movedBlocks(l, next, training.id);
    assert.equal(moved.length, 6);
    assert.equal(Math.max(...moved.map((m) => Math.abs(m.d))), 60);
  });

  test('novi blok u slobodno vreme: ništa drugo se ne pomera', () => {
    const M = createBlockStack(0);
    const A = M.anchor(13 * 60 + 10);
    const l = sampleDay(M);
    const tail = l[l.length - 1];
    const prep = must(M.prepareInsert(l, { mode: 'free', freeId: tail.id, off: 30 }, A));
    assert.deepEqual(prep, { spec: { mode: 'free', freeId: tail.id, off: 30 }, dur: 60 });
    const next = must(M.opInsertAt(l, prep.spec, makeBlock({ title: 'Walk', dur: 30 })));
    assert.ok(has(M, next, '23:00-23:30 Walk'));
    assert.deepEqual(M.movedBlocks(l, next), []);
    // Slobodno vreme pre sada nema mesta za ništa novo; tekuće slobodno vreme počinje od nows.
    const past = M.normalize([blk('A', 720), makeFree(120), blk('B', 60)]);
    const B = M.anchor(12 * 60 + 3);
    assert.equal(M.freeRoom(past, 1, B), 5);
    assert.deepEqual(must(M.prepareInsert(past, { mode: 'free', freeId: past[1].id, off: 0 }, B)).spec, { mode: 'free', freeId: past[1].id, off: 5 });
    assert.equal(M.prepareInsert(past, { mode: 'seam', at: 0 }, B), null);
  });

  test('ubaci slobodno vreme ispred Meeting-a', () => {
    const M = createBlockStack(0);
    const l = sampleDay(M);
    const next = must(M.opInsert(l, idx(M, l, 'Meeting'), makeFree(30)));
    assert.ok(has(M, next, '17:00-17:30 ·free') && has(M, next, '17:30-18:30 Meeting'));
  });

  test('posle ponoći: blok preko ponoći je u redu, blok koji počinje posle kraja dana se označava', () => {
    const M = createBlockStack(0);
    let l = sampleDay(M, false);
    const reading = byTitle(l, 'Reading');
    for (let k = 0; k < 7; k++) l = must(M.opResizeBy(l, reading.id, 15, null));
    assert.equal(startOfTitle(M, l, 'Reading'), 1290);
    assert.equal(M.total(l), 1455);
    assert.equal(l[l.length - 1].kind, 'block');
    assert.deepEqual(M.overflowing(l), []);
    const out = toBlocks(l, M.frame);
    assert.deepEqual(out.invalid, []);
    assert.deepEqual(out.blocks.at(-1), { id: 12, start: 1290, end: 1455, title: 'Reading', categoryId: 1, status: 'pending', actualMin: null, note: '' });
    // Dinner duži za 3h gura Reading posle kraja dana (upozorenje), opseg i dalje ispravan.
    l = must(M.opResize(l, byTitle(l, 'Dinner').id, 240));
    assert.deepEqual(M.overflowing(l).map((b) => b.title), ['Reading']);
    assert.equal(startOfTitle(M, l, 'Reading'), 1470);
    assert.deepEqual(toBlocks(l, M.frame).invalid, []);
  });

  test('dayStart 60 i "sada" posle ponoći (00:41 = minut 1481)', () => {
    const M = createBlockStack(60);
    const l = M.normalize([blk('Sleep', 420, 'done'), makeFree(840), blk('Late', 90)]);
    assert.deepEqual(lines(M, l), ['01:00-08:00 Sleep [done]', '08:00-22:00 ·free', '22:00-23:30 Late', '23:30-01:00 ·free']);
    const A = must(M.anchor(1481.5));
    assert.equal(A.nows, 1485);
    // Late (22:00–23:30) je prošao; slobodno 23:30–01:00 je tekuće.
    const { cur, ff } = M.info(l, A);
    assert.equal(cur, 3);
    assert.equal(ff, 4);
    assert.equal(M.freeRoom(l, 3, A), 1485 - 1410);
    const next = must(M.opInsertInFree(l, l[3].id, must(M.freeRoom(l, 3, A)), makeBlock({ title: 'Read', dur: 15 })));
    assert.ok(M.pastOk(l, next, A));
    assert.deepEqual(lines(M, next).slice(-2), ['23:30-00:45 ·free', '00:45-01:00 Read']);
    assert.equal(M.total(next), 1440);
    // Kraj dana je 01:00 (posle ponoći); blok preko 01:00 ostaje ispravan opseg.
    const end = toBlocks(next, M.frame).blocks.at(-1);
    assert.deepEqual([end?.start, end?.end], [1485, 1500]);
  });
});

// ---------------- Sidrenje (danas) ----------------

describe('sidrenje: prošlost se ne pomera', () => {
  const M = createBlockStack(0);
  const A = must(M.anchor(13 * 60 + 8));

  test('info: tekući Lunch, prvi slobodan Deep work, nows 13:10', () => {
    const l = sampleDay(M);
    assert.equal(A.nows, 790);
    const inf = M.info(l, A);
    assert.equal(l[inf.cur].kind === 'block' && (l[inf.cur] as StackBlock).title, 'Lunch');
    assert.equal(inf.ff, idx(M, l, 'Deep work'));
  });

  test('Završi sad: Lunch 12:30–13:10, sledeći blokovi idu ranije (ne pre sada)', () => {
    const l = sampleDay(M);
    const lunch = byTitle(l, 'Lunch');
    const next = must(M.opEndNow(l, lunch.id, A));
    assert.ok(M.pastOk(l, next, A));
    assert.ok(has(M, next, '12:30-13:10 Lunch') && has(M, next, '13:10-16:10 Deep work'));
    assert.equal(M.opEndNow(l, byTitle(l, 'Deep work').id, A), null);
    assert.equal(M.minDurAt(l, idx(M, l, 'Lunch'), A), 40);
    // "Kraće" ne ide ispod nows; ocenjen tekući blok sme da se završi sad.
    assert.equal(M.stepDur(l, lunch.id, -30, A), 40);
    const rated = must(M.opRate(l, lunch.id, 'done'));
    assert.ok(has(M, must(M.opEndNow(rated, lunch.id, A)), '12:30-13:10 Lunch [done]'));
  });

  test('tekući blok premešten kasnije: ostavlja slobodno do 13:10, ostalo ide ranije do 13:10', () => {
    const l = sampleDay(M);
    const lunch = byTitle(l, 'Lunch');
    const spots = M.moveTargets(l, lunch.id, A);
    assert.equal(spots[0].start, 13 * 60 + 10);
    const next = must(M.opMoveTo(l, lunch.id, idx(M, l, 'Deep work') + 1, A));
    assert.ok(M.pastOk(l, next, A));
    assert.ok(has(M, next, '12:00-13:10 ·free') && has(M, next, '13:10-16:10 Deep work') && has(M, next, '16:10-17:10 Lunch'));
    assert.equal(byTitle(next, 'Lunch').status, 'pending');
    const st = M.startsOf(next);
    assert.ok(next.every((c, i) => c.kind === 'free' || !(st[i] > 788 && st[i] < 790)), 'nijedan blok ne počinje između sada i 13:10');
  });

  test('prošao blok bez ocene ide u slobodno vreme (20:00); njegovo vreme ostaje slobodno', () => {
    const l = sampleDay(M);
    const project = byTitle(l, 'Project');
    assert.ok(M.canLift(l, idx(M, l, 'Project'), A));
    assert.ok(!M.canResize(l, idx(M, l, 'Project'), A));
    const gap = must(M.freeAt(l, 20 * 60));
    const next = must(M.opPlace(l, project.id, gap.id, must(M.freeRoom(l, M.idxOf(l, gap.id), A)), A));
    assert.ok(M.pastOk(l, next, A));
    assert.ok(has(M, next, '09:00-11:30 ·free') && has(M, next, '11:30-12:00 Walk [skipped]'));
    assert.equal(startOfTitle(M, next, 'Project'), 1200);
  });

  test('ocenjen prošao blok: ne podiže se, ne pomera se; može da se podeli i obriše', () => {
    const l = sampleDay(M);
    const emails = byTitle(l, 'Emails');
    const i = idx(M, l, 'Emails');
    assert.ok(!M.canLift(l, i, A));
    assert.ok(!M.canResize(l, i, A));
    assert.deepEqual(M.moveTargets(l, emails.id, A), []);
    assert.equal(M.pastOk(l, must(M.opMoveTo(l, emails.id, l.length, A)), A), false);
    // Pomeranje prošlog bloka (npr. preko ripple-a) ne prolazi pastOk.
    const shifted = must(M.opResize(l, byTitle(l, 'Morning').id, 75));
    assert.equal(M.pastOk(l, shifted, A), false);
    // Deljenje ne pomera vreme: prvi deo zadržava ocenu, drugi čeka ocenu.
    const r = must(M.opSplit(l, emails.id, must(M.cuts15(emails.dur, 2))));
    const parts = r.list.filter((c): c is StackBlock => c.kind === 'block' && c.title === 'Emails');
    // Stvarno vreme 40 min je duže od prvog dela (30 min) → briše se.
    assert.deepEqual(parts.map((p) => [p.status, p.actualMin]), [['partial', null], ['pending', null]]);
    assert.deepEqual(M.startsOf(r.list).filter((_, k) => r.list[k].kind === 'block' && (r.list[k] as StackBlock).title !== 'Emails'), M.startsOf(l).filter((_, k) => l[k].kind === 'block' && (l[k] as StackBlock).title !== 'Emails'));
    // Brisanje ocenjenog prošlog bloka je dozvoljeno (na njegovom mestu ostaje slobodno vreme).
    const del = must(M.opDelete(l, emails.id));
    assert.ok(M.pastOk(l, del, A));
    assert.ok(has(M, del, '08:00-09:00 ·free'));
  });

  test('ništa novo pre sada', () => {
    const l = sampleDay(M);
    const early = must(M.opInsert(l, idx(M, l, 'Walk'), makeBlock({ title: 'X', dur: 15 })));
    assert.equal(M.pastOk(l, early, A), false);
    assert.equal(M.prepareInsert(l, { mode: 'seam', at: idx(M, l, 'Lunch') }, A), null);
    // Slobodno 12:00–12:30 je prošlost: nema mesta, ne zatvara se.
    const gapIdx = l.findIndex((c, k) => c.kind === 'free' && M.startsOf(l)[k] === 720);
    assert.equal(M.freeRoom(l, gapIdx, A), null);
    assert.equal(M.opCloseGap(l, l[gapIdx].id, A), null);
  });

  test('tekuće slobodno vreme se zatvara samo do nows', () => {
    const l = M.normalize([blk('A', 780, 'done'), makeFree(60), blk('B', 60)]);
    const next = must(M.opCloseGap(l, l[1].id, A));
    assert.deepEqual(lines(M, next).slice(0, 3), ['00:00-13:00 A [done]', '13:00-13:10 ·free', '13:10-14:10 B']);
  });

  test('raniji dan (anchor Infinity): ništa se ne pomera, ocene i brisanje rade', () => {
    const P = must(M.anchor(Number.POSITIVE_INFINITY));
    const l = sampleDay(M);
    for (let i = 0; i < l.length; i++) {
      assert.equal(M.canResize(l, i, P), false);
      const c = l[i];
      if (c.kind === 'block') assert.deepEqual(M.moveTargets(l, c.id, P), []);
    }
    const lunch = byTitle(l, 'Lunch');
    assert.equal(M.pastOk(l, must(M.opMoveTo(l, lunch.id, l.length, P)), P), false);
    assert.ok(M.pastOk(l, must(M.opRate(l, lunch.id, 'done')), P));
    assert.ok(M.pastOk(l, must(M.opDelete(l, lunch.id)), P));
    assert.equal(M.pastOk(l, must(M.opInsert(l, l.length, makeBlock({ title: 'X', dur: 15 }))), P), false);
  });
});

// ---------------- Deljenje ----------------

describe('deljenje', () => {
  const M = createBlockStack(0);

  test('pravilo kao na serveru: prvi deo zadržava id, status i belešku; ostali su novi, pending, bez beleške', () => {
    const l = M.normalize([makeFree(60), blk('Work', 120, 'done', 100, 'note', 50)]);
    const r = must(M.opSplit(l, 50, [45, 90]));
    const parts = r.list.filter((c): c is StackBlock => c.kind === 'block');
    assert.deepEqual(parts.map((p) => [p.id === 50, p.dur, p.status, p.actualMin, p.note, p.title, p.categoryId]), [
      [true, 45, 'done', null, 'note', 'Work', 1], // 100 > 45 → stvarno vreme se briše
      [false, 45, 'pending', null, '', 'Work', 1],
      [false, 30, 'pending', null, '', 'Work', 1],
    ]);
    assert.deepEqual(r.ids[0], 50);
    assert.equal(new Set(r.ids).size, 3);
    const kept = must(M.opSplit(l, 50, [105]));
    assert.equal((kept.list.find((c) => c.id === 50) as StackBlock).actualMin, 100);
  });

  test('cuts15: jednaki delovi na mreži, ostatak prvim delovima', () => {
    assert.deepEqual(M.cuts15(120, 3), [40, 80]);
    assert.deepEqual(M.cuts15(70, 3), [25, 50]); // 25 + 25 + 20
    assert.deepEqual(M.cuts15(120, 4), [30, 60, 90]);
    assert.deepEqual(M.cuts15(30, 2), [15]);
    assert.deepEqual(M.cuts15(52, 2), [25]); // minuti van mreže idu poslednjem delu (25 + 27)
    assert.equal(M.cuts15(8, 2), null);
    assert.equal(M.cuts15(60, 1), null);
    assert.equal(M.cuts15(15, 4), null);
  });

  test('proizvoljni rezovi: na mreži, bar 5 min, rastući', () => {
    const l = M.normalize([blk('Work', 120, 'pending', null, '', 7)]);
    assert.equal(M.opSplit(l, 7, [3]), null);
    assert.equal(M.opSplit(l, 7, [60, 60]), null);
    assert.equal(M.opSplit(l, 7, [60, 50]), null);
    assert.equal(M.opSplit(l, 7, [117]), null);
    assert.equal(M.opSplit(l, 7, []), null);
    assert.equal(M.opSplit(l, 7, [30.5]), null);
    const r = must(M.opSplit(l, 7, [30, 60, 75]));
    assert.deepEqual(r.list.filter((c) => c.kind === 'block').map((c) => c.dur), [30, 30, 15, 45]);
    // Uređivač rezova.
    assert.equal(M.snapCut(13 * 60 + 30, 37), 35);
    assert.equal(M.snapCut(13 * 60 + 12, 37), 38); // blok van mreže: rez na mreži dana (13:50)
    assert.deepEqual(M.cutAdd(120, [60], 30), [30, 60]);
    assert.equal(M.cutAdd(120, [60], 58), null);
    assert.equal(M.cutAdd(120, [60], 117), null);
    assert.deepEqual(M.cutMove(120, [30, 60], 0, 58), [55, 60]);
    assert.deepEqual(M.cutMove(120, [30, 60], 1, 200), [30, 115]);
  });

  test('blok kraći od 10 min se ne deli na pola', () => {
    const l = M.normalize([blk('Short', 8, 'pending', null, '', 9)]);
    assert.equal(M.cuts15(8, 2), null);
    assert.equal(M.opSplit(l, 9, [4]), null);
  });
});

// ---------------- Brisanje, praznine, pomeranje, trajanje ----------------

describe('brisanje, praznine, klizanje, trajanje', () => {
  const M = createBlockStack(0);

  test('brisanje → slobodno vreme na istom mestu; Zatvori prazninu; dva poništavanja vraćaju dan', () => {
    let l: Stack = sampleDay(M, false);
    l = must(M.opInsert(l, idx(M, l, 'Meeting'), makeFree(30)));
    const meeting = byTitle(l, 'Meeting');
    const m0 = must(M.startOf(l, meeting.id));
    const study0 = startOfTitle(M, l, 'Study');
    let h = emptyHistory<StackSnapshot>();
    const snap = (items: Stack, sel: ItemId | null = null): StackSnapshot => ({ items, sel });

    const del = must(M.opDelete(l, meeting.id));
    h = historyRecord(h, snap(l, meeting.id), { at: 0 });
    assert.ok(has(M, del, `${fmtClock(m0 - 30)}-${fmtClock(m0 + 60)} ·free`));
    assert.equal(startOfTitle(M, del, 'Study'), study0);
    const holder = must(M.freeAt(del, m0));
    const closed = must(M.opCloseGap(del, holder.id, null));
    h = historyRecord(h, snap(del), { at: 1 });
    assert.equal(startOfTitle(M, closed, 'Study'), m0 - 30);

    const u1 = must(historyUndo(h, snap(closed)));
    const u2 = must(historyUndo(u1.history, u1.snap));
    assert.deepEqual(u2.snap.items, l);
    assert.equal(u2.snap.sel, meeting.id);
    const r1 = must(historyRedo(u2.history, u2.snap));
    assert.deepEqual(r1.snap.items, del);
  });

  test('brisanje bloka zadržava id u slobodnom vremenu i spaja se sa susedima', () => {
    const l = M.normalize([blk('A', 60, 'pending', null, '', 1), makeFree(30, 'g'), blk('B', 60, 'pending', null, '', 2)]);
    const d = must(M.opDelete(l, 2));
    assert.deepEqual(d.map((c) => [c.kind, c.id, c.dur]), [['block', 1, 60], ['free', 'g', 1380]]);
    const d2 = must(M.opDelete(l, 1));
    assert.deepEqual(d2.map((c) => [c.kind, c.id, c.dur]).slice(0, 2), [['free', 1, 90], ['block', 2, 60]]);
    assert.equal(M.opDelete(l, 'g'), null);
  });

  test('zatvaranje praznine: sledeći blokovi idu ranije, kraj dana raste', () => {
    const l = sampleDay(M, false);
    const gap = must(M.freeAt(l, 12 * 60));
    const next = must(M.opCloseGap(l, gap.id, null));
    assert.ok(has(M, next, '12:00-13:00 Lunch'));
    assert.equal(M.opCloseGap(next, next[next.length - 1].id, null), null);
  });

  test('klizanje jedan korak mreže (5 min) kroz slobodno vreme (Alt+Shift+↑↓)', () => {
    const l = M.normalize([blk('A', 60, 'pending', null, '', 1), makeFree(30), blk('B', 60, 'pending', null, '', 2)]);
    const up = must(M.opNudge(l, 2, -1));
    assert.deepEqual(lines(M, up).slice(0, 4), ['00:00-01:00 A', '01:00-01:25 ·free', '01:25-02:25 B', '02:25-00:00 ·free']);
    const down = must(M.opNudge(l, 1, 1));
    assert.deepEqual(lines(M, down).slice(0, 3), ['00:00-00:05 ·free', '00:05-01:05 A', '01:05-01:30 ·free']);
    assert.equal(M.opNudge(l, 1, -1), null);
    assert.equal(M.total(up), 1440);
  });

  test('Alt+↑↓ jedno mesto; ništa se ne preuređuje samo od sebe', () => {
    const l = M.normalize([blk('A', 60, 'pending', null, '', 1), blk('B', 30, 'pending', null, '', 2), blk('C', 45, 'pending', null, '', 3)]);
    const down = must(M.opMoveBy(l, 1, 1, null));
    assert.deepEqual(lines(M, down).slice(0, 3), ['00:00-00:30 B', '00:30-01:30 A', '01:30-02:15 C']);
    const up = must(M.opMoveBy(l, 3, -1, null));
    assert.deepEqual(lines(M, up).slice(0, 3), ['00:00-01:00 A', '01:00-01:45 C', '01:45-02:15 B']);
    assert.equal(M.opMoveBy(l, 1, -1, null), null);
  });

  test('Kraće/Duže (±15 min) poravnava kraj na mrežu od 5 min; najkraće 5 min; najduže 24h', () => {
    const l = M.normalize([makeFree(12), blk('Off', 40, 'pending', null, '', 1)]); // 00:12–00:52
    assert.equal(M.stepDur(l, 1, 15, null), 53); // kraj 01:07 → 01:05
    assert.equal(M.stepDur(l, 1, -15, null), 28); // kraj 00:37 → 00:40
    const short = M.normalize([blk('S', 15, 'pending', null, '', 2)]);
    assert.equal(M.stepDur(short, 2, -15, null), 5);
    assert.equal(M.opResize(short, 2, 1441), null);
    assert.equal(M.opResize(short, 2, 0), null);
    assert.equal(M.opResize(short, 2, 15), null);
    // Stvarno vreme duže od novog trajanja se briše (kao na serveru); kraće ostaje.
    const rated = M.normalize([blk('R', 120, 'done', 100, '', 5)]);
    assert.equal((must(M.opResize(rated, 5, 90))[0] as StackBlock).actualMin, null);
    assert.equal((must(M.opResize(rated, 5, 105))[0] as StackBlock).actualMin, 100);
    // Duže gura samo do prvog slobodnog vremena.
    const day = sampleDay(M, false);
    const next = must(M.opResizeBy(day, byTitle(day, 'Meeting').id, 30, null));
    assert.ok(has(M, next, '17:00-18:30 Meeting') && has(M, next, '18:30-20:30 Study') && has(M, next, '20:30-21:30 Dinner'));
  });

  test('opseg mora ostati ispravan (početak < 2880): takva izmena se odbija', () => {
    const M2 = createBlockStack(360);
    // A 06:00–06:00 (360–1800), B 1800–2865, C 2865–2880: C počinje pre 2880.
    const l = M2.normalize([blk('A', 1440, 'pending', null, '', 1), blk('B', 1065, 'pending', null, '', 2), blk('C', 15, 'pending', null, '', 3)]);
    assert.ok(M2.fits(l));
    assert.ok(M2.opResize(l, 3, 30)); // kraj posle 2880 je u redu, početak nije
    assert.equal(M2.opResize(l, 2, 1080), null);
    assert.equal(M2.opInsert(l, 2, makeBlock({ title: 'X', dur: 30 })), null);
    assert.equal(M2.opResize(l, 1, 1441), null);
  });
});

// ---------------- Gornja ivica (početak bloka) ----------------

describe('gornja ručica: početak bloka', () => {
  const M = createBlockStack(0);

  test('5 min slobodno pre bloka: početak 5 min ranije, ništa drugo se ne pomera', () => {
    const l = M.normalize([blk('A', 60, 'pending', null, '', 1), makeFree(5), blk('B', 60, 'pending', null, '', 2), blk('C', 30, 'pending', null, '', 3)]);
    assert.deepEqual(M.startRange(l, 2, null), { min: 60, max: 120 });
    const next = must(M.opResizeStart(l, 2, 60, null));
    assert.deepEqual(lines(M, next).slice(0, 3), ['00:00-01:00 A', '01:00-02:05 B', '02:05-02:35 C']);
    assert.deepEqual(M.movedBlocks(l, next, 2), []);
    assert.equal(M.total(next), 1440);
  });

  test('bez slobodnog vremena pre bloka: raniji blok ide ranije dok slobodno vreme ne upije razliku', () => {
    const l = M.normalize([makeFree(30), blk('A', 60, 'pending', null, '', 1), blk('B', 60, 'pending', null, '', 2)]);
    assert.deepEqual(M.startRange(l, 2, null), { min: 60, max: 145 });
    const next = must(M.opResizeStart(l, 2, 75, null));
    assert.deepEqual(lines(M, next).slice(0, 3), ['00:00-00:15 ·free', '00:15-01:15 A', '01:15-02:30 B']);
    // Nema dovoljno slobodnog vremena (početak bi bio pre početka okvira).
    assert.equal(M.opResizeStart(l, 2, 55, null), null);
    // Prvo se troši najbliže slobodno vreme, pa sledeće (i blok između ide ranije).
    const l2 = M.normalize([blk('A', 60, 'pending', null, '', 1), makeFree(10), blk('B', 30, 'pending', null, '', 2), makeFree(20), blk('C', 60, 'pending', null, '', 3)]);
    const n2 = must(M.opResizeStart(l2, 3, 95, null));
    assert.deepEqual(lines(M, n2).slice(0, 4), ['00:00-01:00 A', '01:00-01:05 ·free', '01:05-01:35 B', '01:35-03:00 C']);
  });

  test('prošlost se ne pomera: danas ni pre nows, počet blok ne menja početak', () => {
    const A = must(M.anchor(13 * 60 + 8)); // nows 13:10
    const l = M.normalize([blk('Past', 780, 'done', null, '', 1), makeFree(20), blk('Next', 60, 'pending', null, '', 2)]);
    assert.deepEqual(M.startRange(l, 2, A), { min: 790, max: 855 });
    const next = must(M.opResizeStart(l, 2, 790, A));
    assert.deepEqual(lines(M, next).slice(0, 3), ['00:00-13:00 Past [done]', '13:00-13:10 ·free', '13:10-14:20 Next']);
    assert.ok(M.pastOk(l, next, A));
    assert.equal(M.opResizeStart(l, 2, 785, A), null);
    assert.equal(M.opResizeStart(l, 1, 700, A), null);
    assert.equal(M.canResizeStart(l, 0, A), false);
    // Bez slobodnog vremena pre bloka, a raniji blok je prošao: ne sme ranije.
    const tight = M.normalize([blk('Past', 790, 'done', null, '', 1), blk('Next', 60, 'pending', null, '', 2)]);
    assert.equal(M.startRange(tight, 2, A)?.min, 790);
    assert.equal(M.opResizeStart(tight, 2, 785, A), null);
    // Šablon (bez sidra) isto pravilo, ali bez prošlosti.
    assert.ok(M.opResizeStart(l, 2, 785, null));
    // Raniji dan: ništa.
    assert.equal(M.startRange(l, 2, M.anchor(Number.POSITIVE_INFINITY)), null);
  });

  test('kasniji početak: pre bloka ostaje slobodno vreme; najkraće 5 min', () => {
    const l = M.normalize([blk('A', 60, 'pending', null, '', 1), blk('B', 60, 'pending', null, '', 2), blk('C', 30, 'pending', null, '', 3)]);
    const next = must(M.opResizeStart(l, 2, 80, null));
    assert.deepEqual(lines(M, next).slice(0, 4), ['00:00-01:00 A', '01:00-01:20 ·free', '01:20-02:00 B', '02:00-02:30 C']);
    assert.deepEqual(M.movedBlocks(l, next, 2), []);
    assert.ok(M.opResizeStart(l, 2, 115, null));
    assert.equal(M.opResizeStart(l, 2, 116, null), null);
    // Spaja se sa slobodnim vremenom koje je već pre bloka.
    const l2 = M.normalize([blk('A', 60, 'pending', null, '', 1), makeFree(10), blk('B', 60, 'pending', null, '', 2)]);
    assert.deepEqual(lines(M, must(M.opResizeStart(l2, 2, 85, null))).slice(0, 3), ['00:00-01:00 A', '01:00-01:25 ·free', '01:25-02:10 B']);
  });
});

// ---------------- Konverzije ----------------

describe('fromBlocks / toBlocks', () => {
  test('praznine postaju slobodno vreme (i od početka dana); povratak daje iste blokove', () => {
    const blocks = [
      serverBlock(3, 600, 660, 'Work', { status: 'done', actualMin: 50, note: 'ok' }),
      serverBlock(2, 420, 480, 'Morning'),
      serverBlock(4, 1380, 1500, 'Late'),
    ];
    const r = fromBlocks(blocks, 0);
    assert.deepEqual(r.frame, { start: 0, end: 1440 });
    assert.deepEqual(r.overlaps, []);
    const M = createBlockStack(r.frame);
    assert.deepEqual(lines(M, r.items), ['00:00-07:00 ·free', '07:00-08:00 Morning', '08:00-10:00 ·free', '10:00-11:00 Work [done]', '11:00-23:00 ·free', '23:00-01:00 Late']);
    const out = toBlocks(r.items, r.frame);
    assert.deepEqual(out.invalid, []);
    assert.deepEqual(
      out.blocks.map((b) => [b.id, b.start, b.end, b.title, b.status, b.actualMin, b.note]),
      [
        [2, 420, 480, 'Morning', 'pending', null, ''],
        [3, 600, 660, 'Work', 'done', 50, 'ok'],
        [4, 1380, 1500, 'Late', 'pending', null, ''],
      ],
    );
  });

  test('dayStart 60: okvir 01:00–01:00; blok 00:00–01:00 posle ponoći je na kraju dana', () => {
    const r = fromBlocks([serverBlock(1, 60, 540, 'Sleep'), serverBlock(2, 1440, 1500, 'After midnight')], 60);
    assert.deepEqual(r.frame, { start: 60, end: 1500 });
    const M = createBlockStack(r.frame);
    assert.deepEqual(lines(M, r.items), ['01:00-09:00 Sleep', '09:00-00:00 ·free', '00:00-01:00 After midnight']);
    assert.equal(M.total(r.items), 1440);
    assert.deepEqual(toBlocks(r.items, r.frame).blocks.map((b) => [b.start, b.end]), [[60, 540], [1440, 1500]]);
  });

  test('blok sačuvan pre promene početka dana (počinje pre dayStart) pomera početak okvira', () => {
    const r = fromBlocks([serverBlock(1, 30, 120, 'Early'), serverBlock(2, 600, 660, 'Work')], 60);
    assert.deepEqual(r.frame, { start: 30, end: 1500 });
    const M = createBlockStack(r.frame);
    assert.equal(M.total(r.items), 1470);
    assert.deepEqual(toBlocks(r.items, r.frame).blocks.map((b) => [b.start, b.end]), [[30, 120], [600, 660]]);
  });

  test('preklapanja se prijavljuju; items = raspored posle "Popravi" (kasniji blok ide iza, redosled ostaje)', () => {
    const r = fromBlocks([serverBlock(1, 600, 720, 'A'), serverBlock(2, 660, 690, 'B'), serverBlock(3, 700, 760, 'C'), serverBlock(4, 900, 960, 'D')], 0);
    assert.deepEqual(r.overlaps, [{ a: 1, b: 2 }, { a: 1, b: 3 }]);
    const M = createBlockStack(r.frame);
    assert.deepEqual(lines(M, r.items).slice(1, 6), ['10:00-12:00 A', '12:00-12:30 B', '12:30-13:30 C', '13:30-15:00 ·free', '15:00-16:00 D']);
  });

  test('pregled iz šablona (negativni id-jevi) i blokovi šablona idu bez id-ja', () => {
    const preview = [serverBlock(-1, 480, 540, 'A'), serverBlock(-2, 540, 600, 'B')];
    const r = fromBlocks(preview, 0);
    const out = toBlocks(r.items, r.frame, { confirmed: preview });
    assert.deepEqual(out.blocks, [
      { start: 480, end: 540, title: 'A', categoryId: null },
      { start: 540, end: 600, title: 'B', categoryId: null },
    ]);
    const tpl = fromBlocks([{ id: 9, start: 480, end: 540, title: 'T', categoryId: 2 }], 0);
    assert.equal((tpl.items[1] as StackBlock).status, 'pending');
    assert.deepEqual(toTemplateBlocks(tpl.items, tpl.frame).blocks, [{ start: 480, end: 540, title: 'T', categoryId: 2 }]);
  });

  test('toBlocks sa potvrđenim stanjem: šalje samo promenjena polja; nepoznat id ide kao nov blok', () => {
    const confirmed = [serverBlock(1, 480, 540, 'A', { status: 'done', note: 'n' }), serverBlock(2, 540, 600, 'B')];
    const r = fromBlocks(confirmed, 0);
    const M = createBlockStack(r.frame);
    let l = must(M.opRate(r.items, 2, 'partial'));
    l = must(M.opUpdate(l, 2, { actualMin: 20 }));
    l = M.normalize([...l, makeBlock({ id: 77, title: 'Undeleted', dur: 30, status: 'skipped', note: 'back' }), makeBlock({ title: 'New', dur: 15 })]);
    const out = toBlocks(l, r.frame, { confirmed }).blocks;
    assert.deepEqual(out[0], { id: 1, start: 480, end: 540, title: 'A', categoryId: null });
    assert.deepEqual(out[1], { id: 2, start: 540, end: 600, title: 'B', categoryId: null, status: 'partial', actualMin: 20 });
    // Id koji server više nema (blok vraćen poništavanjem brisanja) ide bez id-ja, sa svojom ocenom.
    assert.equal(out.find((b) => b.title === 'Undeleted')?.id, undefined);
    assert.equal(out.find((b) => b.title === 'Undeleted')?.status, 'skipped');
    assert.deepEqual(out.find((b) => b.title === 'New'), { start: out.at(-1)?.start, end: out.at(-1)?.end, title: 'New', categoryId: null });
  });

  test('layoutBase: isti za isti raspored (bez obzira na redosled), drugačiji posle izmene', () => {
    const a = [serverBlock(1, 480, 540, 'A'), serverBlock(2, 540, 600, 'B')];
    assert.equal(layoutBase(a), layoutBase([a[1], a[0]]));
    assert.match(layoutBase(a), /^2-[0-9a-z]+$/);
    assert.notEqual(layoutBase(a), layoutBase([a[0], { ...a[1], status: 'done' }]));
    assert.notEqual(layoutBase(a), layoutBase([a[0], { ...a[1], end: 615 }]));
    assert.notEqual(layoutBase(a), layoutBase([a[0], { ...a[1], title: 'C' }]));
    assert.notEqual(layoutBase(a), layoutBase([a[0], { ...a[1], id: 3 }]));
    assert.match(layoutBase([]), /^0-[0-9a-z]+$/);
  });

  test('templateBase: sadržaj šablona (bez id-jeva i redosleda); menja se sa vremenom, nazivom i kategorijom', () => {
    const a = [
      { id: 7, start: 480, end: 540, title: 'A', categoryId: 3 },
      { id: 8, start: 540, end: 600, title: 'B', categoryId: null },
    ];
    // Isti sadržaj sa novim id-jevima (server ih daje pri svakom čuvanju) i drugim redosledom.
    const renumbered = [{ ...a[1], id: 20 }, { ...a[0], id: 21 }];
    assert.equal(templateBase(a), templateBase(renumbered));
    assert.match(templateBase(a), /^2-[0-9a-z]+$/);
    assert.notEqual(templateBase(a), templateBase([a[0], { ...a[1], end: 615 }]));
    assert.notEqual(templateBase(a), templateBase([a[0], { ...a[1], title: 'C' }]));
    assert.notEqual(templateBase(a), templateBase([a[0], { ...a[1], categoryId: 3 }]));
    assert.notEqual(templateBase(a), templateBase([a[0]]));
    // Isti početak i kraj (preklapanje iz starijih podataka): redosled ulaza i dalje nije bitan.
    const twins = [
      { start: 600, end: 660, title: 'X', categoryId: null },
      { start: 600, end: 660, title: 'Y', categoryId: 2 },
    ];
    assert.equal(templateBase(twins), templateBase([twins[1], twins[0]]));
    // Niz → blokovi šablona → isti otisak kao sačuvani blokovi.
    const f = fromBlocks(a, 0);
    assert.equal(templateBase(toTemplateBlocks(f.items, f.frame).blocks), templateBase(a));
  });
});

// ---------------- Istorija ----------------

describe('istorija', () => {
  test('ponovljena izmena sa istom oznakom u roku od 4 s je jedan korak; limit 200; ponovi se briše', () => {
    let h = emptyHistory<number>();
    h = historyRecord(h, 1, { tag: 'len:a', at: 0 });
    h = historyRecord(h, 2, { tag: 'len:a', at: 3000 });
    h = historyRecord(h, 3, { tag: 'len:a', at: 6500 });
    assert.deepEqual(h.past.map((e) => e.snap), [1]);
    h = historyRecord(h, 4, { tag: 'len:a', at: 11000 });
    h = historyRecord(h, 5, { tag: 'len:b', at: 11001 });
    h = historyRecord(h, 6, { at: 11002 });
    h = historyRecord(h, 7, { at: 11003 });
    assert.deepEqual(h.past.map((e) => e.snap), [1, 4, 5, 6, 7]);
    const u = must(historyUndo(h, 8));
    assert.equal(u.snap, 7);
    assert.deepEqual(u.history.future.map((e) => e.snap), [8]);
    assert.deepEqual(historyRecord(u.history, 9, { at: 20000 }).future, []);
    assert.equal(historyUndo(emptyHistory<number>(), 1), null);
    assert.equal(historyRedo(emptyHistory<number>(), 1), null);
    let big = emptyHistory<number>();
    for (let k = 0; k < 250; k++) big = historyRecord(big, k, { at: k });
    assert.equal(big.past.length, 200);
    assert.equal(big.past[0].snap, 50);
  });
});

// ---------------- Nasumični test ----------------

/** LCG kao u prototipu (deterministički). */
function rng(seed: number) {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)],
  };
}

const OPS = [
  'resize',
  'resizeBy',
  'endNow',
  'move',
  'moveBy',
  'place',
  'insert',
  'insertSpec',
  'insertFree',
  'delete',
  'close',
  'split',
  'splitCustom',
  'nudge',
  'resizeStart',
  'targets',
  'rate',
  'update',
] as const;

describe('nasumični test (seme)', () => {
  test('≥ 50 000 izmena: bez preklapanja, u okviru dana, trajanja ≥ 5m, zbirovi, jedinstveni id-jevi, prošlost', () => {
    const R = rng(20261009);
    let applied = 0;
    let refused = 0;
    const fails: string[] = [];
    const fail = (msg: string) => {
      if (fails.length < 10) fails.push(msg);
    };
    const blockSum = (l: Stack) => l.reduce((s, c) => s + (c.kind === 'block' ? c.dur : 0), 0);
    /** Početak svakog bloka kad se ništa ne pomera. */
    const still = (M: BlockStackModel, prev: Stack): Map<ItemId, number> => {
      const ps = M.startsOf(prev);
      return new Map(prev.flatMap((x, k) => (x.kind === 'block' ? [[x.id, ps[k]] as const] : [])));
    };
    /**
     * Pravilo talasa: od indeksa `from` stavke se pomeraju za `d`. d > 0: slobodna vremena redom upijaju razliku, pa
     * se blok pomera za max(0, d − slobodno pre njega); d < 0: blokovi do prvog slobodnog vremena idu ranije, posle
     * njega ostaju (ono raste). Blokovi pre `from` ostaju.
     */
    const ripple = (M: BlockStackModel, prev: Stack, from: number, d: number): Map<ItemId, number> => {
      const ps = M.startsOf(prev);
      const out = new Map<ItemId, number>();
      let freeSeen = 0;
      prev.forEach((x, k) => {
        if (x.kind === 'free') {
          if (k >= from) freeSeen += x.dur;
          return;
        }
        out.set(x.id, k < from ? ps[k] : d > 0 ? ps[k] + Math.max(0, d - freeSeen) : freeSeen > 0 ? ps[k] : ps[k] + d);
      });
      return out;
    };
    /**
     * Ogledalo talasa za gornju ivicu bloka `i` (početak se pomera za −d, kraj ostaje): blokovi posle njega ostaju;
     * d > 0: blok pre njega ide ranije za max(0, d − slobodno između njih); d < 0: ništa pre njega se ne pomera.
     * `before` = false: blokovi pre `i` se ne proveravaju (danas slobodno vreme pre nows ne daje vreme).
     */
    const rippleUp = (M: BlockStackModel, prev: Stack, i: number, d: number, before: boolean): Map<ItemId, number> => {
      const ps = M.startsOf(prev);
      const out = new Map<ItemId, number>();
      let freeSeen = 0;
      for (let k = prev.length - 1; k >= 0; k--) {
        const x = prev[k];
        if (x.kind === 'free') {
          if (k < i) freeSeen += x.dur;
          continue;
        }
        if (k > i || (k < i && d < 0)) out.set(x.id, ps[k]);
        else if (k === i) out.set(x.id, ps[k] - d);
        else if (before) out.set(x.id, ps[k] - Math.max(0, d - freeSeen));
      }
      return out;
    };

    for (const dayStart of [0, 60]) {
      const M = createBlockStack(dayStart);
      const anchors: Array<Anchor | null> = [null, M.anchor(dayStart + 790), M.anchor(Number.POSITIVE_INFINITY)];
      // Primer na mreži (kao u prototipu) i "uvezen" dan van mreže (stari podaci: 12-min blok, praznine od 8 i 10 min).
      const seeds: Array<{ grid: boolean; make: () => StackItem[] }> = [
        {
          grid: true,
          make: () =>
            M.normalize([
              blk('a', 420, 'done', null, '', 1), blk('b', 60, 'done', null, '', 2), blk('c', 150, 'pending', null, '', 3),
              blk('d', 30, 'skipped', null, 'n', 4), makeFree(30), blk('e', 60, 'partial', 20, '', 5), blk('f', 180, 'pending', null, '', 6),
              blk('g', 30, 'pending', null, '', 7), blk('h', 60, 'pending', null, '', 8), blk('i', 120, 'pending', null, '', 9), makeFree(30),
              blk('j', 60, 'pending', null, '', 10), blk('k', 60, 'pending', null, '', 11),
            ]),
        },
        {
          grid: false,
          make: () =>
            fromBlocks(
              [
                serverBlock(21, dayStart, dayStart + 425, 'Sleep', { status: 'done' }),
                serverBlock(22, dayStart + 425, dayStart + 437, 'Coffee', { status: 'done' }),
                serverBlock(23, dayStart + 445, dayStart + 700, 'Work', { status: 'partial', actualMin: 100 }),
                serverBlock(24, dayStart + 700, dayStart + 750, 'Lunch'),
                serverBlock(25, dayStart + 760, dayStart + 845, 'Training'),
                serverBlock(26, dayStart + 845, dayStart + 1100, 'Rest', { note: 'x' }),
                serverBlock(27, dayStart + 1380, dayStart + 1505, 'Late'),
              ],
              dayStart,
            ).items,
        },
      ];
      for (const A of anchors) {
        for (const sd of seeds) {
          for (let run = 0; run < 200; run++) {
            let l: StackItem[] = sd.make();
            for (let step = 0; step < 60; step++) {
              const prev = l;
              const n = l.length;
              const i = R.int(n);
              const c = l[i];
              const op = R.pick(OPS);
              let next: StackItem[] | null = null;
              let delta: number | null = 0; // očekivana promena zbira trajanja blokova
              let expect: Map<ItemId, number> | null = null; // očekivani početak blokova (pravilo talasa)
              let exceptId: ItemId | null = null;
              const inf = M.info(l, A);
              switch (op) {
                case 'resize':
                  if (c.kind === 'block' && M.canResize(l, i, A)) {
                    const d = Math.max(M.minDurAt(l, i, A), c.dur + R.pick([-30, -15, -5, 5, 15, 45, 90]));
                    next = M.opResize(l, c.id, d);
                    delta = d - c.dur;
                    expect = ripple(M, l, i + 1, d - c.dur);
                  }
                  break;
                case 'resizeBy': {
                  const d = M.stepDur(l, c.id, R.pick([-30, -15, 15, 30]), A);
                  next = d == null ? null : M.opResize(l, c.id, d);
                  delta = c.kind === 'block' && d != null ? d - c.dur : 0;
                  if (d != null) expect = ripple(M, l, i + 1, d - c.dur);
                  break;
                }
                case 'endNow': {
                  next = M.opEndNow(l, c.id, A);
                  if (next) delta = must(next.find((x) => x.id === c.id)).dur - c.dur;
                  if (next) expect = ripple(M, l, i + 1, delta);
                  break;
                }
                case 'move':
                  if (M.canLift(l, i, A)) next = M.opMoveTo(l, c.id, R.int(n + 1), A);
                  break;
                case 'moveBy':
                  next = M.opMoveBy(l, c.id, R.pick([-1, 1] as const), A);
                  break;
                case 'place':
                  if (M.canLift(l, i, A)) {
                    const fs = l.map((f, j) => [f, j] as const).filter(([f, j]) => f.kind === 'free' && j !== i && M.freeRoom(l, j, A) != null);
                    if (fs.length) {
                      const [f, j] = R.pick(fs);
                      next = M.opPlace(l, c.id, f.id, must(M.freeRoom(l, j, A)) + 15 * R.int(3), A);
                    }
                  }
                  break;
                case 'insert': {
                  const k = R.int(n + 1);
                  if (!A || k >= inf.ff) {
                    const item = R.next() < 0.75 ? makeBlock({ title: 'new', dur: R.pick([15, 30, 60]) }) : makeFree(R.pick([15, 30]));
                    next = M.opInsert(l, k, item);
                    delta = item.kind === 'block' ? item.dur : 0;
                    expect = ripple(M, l, k, item.dur);
                  }
                  break;
                }
                case 'insertSpec': {
                  const prep = M.prepareInsert(l, M.defaultInsertSpec(l, A), A);
                  if (prep) {
                    next = M.opInsertAt(l, prep.spec, makeBlock({ title: 'spec', dur: prep.dur }));
                    delta = prep.dur;
                    if (prep.spec.mode === 'seam') expect = ripple(M, l, prep.spec.at, prep.dur);
                    else {
                      const j = M.idxOf(l, prep.spec.freeId);
                      const over = prep.spec.off + prep.dur - l[j].dur;
                      expect = over > 0 ? ripple(M, l, j + 1, over) : still(M, l);
                    }
                  }
                  break;
                }
                case 'insertFree':
                  if (c.kind === 'free' && M.freeRoom(l, i, A) != null) {
                    const d = R.pick([15, 30, 60, 120]);
                    const off = Math.min(c.dur, must(M.freeRoom(l, i, A)) + 15 * R.int(2));
                    next = M.opInsertInFree(l, c.id, off, makeBlock({ title: 'in', dur: d }));
                    delta = d;
                    expect = off + d > c.dur ? ripple(M, l, i + 1, off + d - c.dur) : still(M, l);
                  }
                  break;
                case 'delete':
                  next = M.opDelete(l, c.id);
                  delta = -c.dur;
                  expect = still(M, l);
                  break;
                case 'close':
                  next = M.opCloseGap(l, c.id, A);
                  if (next) {
                    const keep = A ? Math.max(0, A.nows - inf.st[i]) : 0;
                    expect = ripple(M, l, i + 1, -(c.dur - keep));
                  }
                  break;
                case 'split':
                  if (c.kind === 'block') {
                    const cuts = M.cuts15(c.dur, R.pick([2, 3, 4]));
                    if (cuts) next = must(M.opSplit(l, c.id, cuts)).list;
                  }
                  break;
                case 'splitCustom':
                  if (c.kind === 'block') {
                    let cuts: number[] = [];
                    const st = M.startsOf(l)[i];
                    for (let k = 0; k < 4; k++) cuts = M.cutAdd(c.dur, cuts, M.snapCut(st, R.int(c.dur))) ?? cuts;
                    if (cuts.length && R.next() < 0.5) cuts = M.cutMove(c.dur, cuts, R.int(cuts.length), cuts[0] + R.pick([-15, 15, 30]));
                    if (cuts.length) next = M.opSplit(l, c.id, cuts)?.list ?? null;
                    if (cuts.length && !next) fail(`splitCustom odbijen: ${c.dur} ${JSON.stringify(cuts)}`);
                  }
                  break;
                case 'nudge':
                  if (M.canLift(l, i, A)) next = M.opNudge(l, c.id, R.pick([-1, 1] as const));
                  expect = still(M, l);
                  exceptId = c.id;
                  break;
                case 'resizeStart': {
                  const r = M.startRange(l, c.id, A);
                  if (r) {
                    const st = inf.st[i];
                    const start = Math.min(r.max, Math.max(r.min, st + R.pick([-90, -30, -15, -5, 5, 15, 45])));
                    next = M.opResizeStart(l, c.id, start, A);
                    if (start !== st && !next) fail(`resizeStart odbijen u opsegu ${r.min}..${r.max}: ${st} → ${start} (ds${dayStart} A${A ? A.now : '-'} ${sd.grid ? 'grid' : 'off'})`);
                    delta = st - start;
                    expect = rippleUp(M, l, i, st - start, !A);
                  } else if (c.kind === 'block' && M.opResizeStart(l, c.id, inf.st[i] - 5, A)) fail('resizeStart van opsega');
                  break;
                }
                case 'targets':
                  if (M.canLift(l, i, A)) {
                    const ts = M.moveTargets(l, c.id, A);
                    for (const t of ts) if (!M.pastOk(l, t.next, A) || !M.fits(t.next)) fail(`cilj krši prošlost/opseg (${op})`);
                    if (ts.length) next = R.pick(ts).next;
                  }
                  break;
                case 'rate':
                  next = M.opRate(l, c.id, R.pick(['done', 'partial', 'skipped'] as const));
                  expect = still(M, l);
                  break;
                case 'update':
                  next = M.opUpdate(l, c.id, { title: `t${R.int(5)}`, note: R.pick(['', 'x']) });
                  expect = still(M, l);
                  break;
              }
              if (!next) continue;
              const split = op === 'split' || op === 'splitCustom';
              // Deljenje ne pomera vreme (UI mu veruje); ostalo prolazi kroz pastOk kao u UI-ju.
              if (!split && !M.pastOk(prev, next, A)) {
                refused++;
                continue;
              }
              l = next;
              applied++;
              const tag = `${op} ds${dayStart} A${A ? A.now : '-'} ${sd.grid ? 'grid' : 'off'}`;

              // --- invarijante ---
              if (l.some((x) => !(x.dur > 0) || !Number.isInteger(x.dur))) fail(`trajanje ≤ 0 ili neceo broj (${tag})`);
              if (new Set(l.map((x) => x.id)).size !== l.length) fail(`dupli id (${tag})`);
              for (let k = 1; k < l.length; k++) if (l[k].kind === 'free' && l[k - 1].kind === 'free') fail(`susedna slobodna vremena (${tag})`);
              const tot = M.total(l);
              if (tot < M.LEN) fail(`zbir < 24h (${tag})`);
              if (tot > M.LEN && l[l.length - 1].kind === 'free') fail(`prepun dan sa slobodnim na kraju (${tag})`);
              if (!M.fits(l)) fail(`neispravan opseg (${tag})`);
              const prevDur = new Map(prev.map((x) => [x.id, x.dur]));
              for (const x of l) {
                if (x.kind === 'block' && x.dur < M.MIN && prevDur.get(x.id) !== x.dur) fail(`blok kraći od ${M.MIN} min (${tag})`);
                if (sd.grid && x.dur % M.SNAP !== 0) fail(`trajanje van mreže (${tag}: ${x.kind} ${x.dur})`);
              }
              if (delta != null && blockSum(l) !== blockSum(prev) + delta) fail(`zbir blokova ${blockSum(prev)} → ${blockSum(l)}, očekivano ${delta} (${tag})`);

              // toBlocks: sortirano, bez preklapanja, ispravni opsezi; povratak kroz fromBlocks daje isti dan.
              const out = toBlocks(l, M.frame);
              if (out.invalid.length) fail(`toBlocks: neispravan opseg (${tag})`);
              for (let k = 0; k < out.blocks.length; k++) {
                const b = out.blocks[k];
                if (!isValidRange(b.start, b.end)) fail(`toBlocks: opseg (${tag})`);
                if (k && b.start < out.blocks[k - 1].end) fail(`toBlocks: preklapanje (${tag})`);
                if (b.start < M.frame.start) fail(`toBlocks: pre početka dana (${tag})`);
              }
              if (applied % 7 === 0) {
                const back = fromBlocks(
                  out.blocks.map((b, k) => ({ ...b, id: b.id ?? 100000 + k })),
                  dayStart,
                );
                const flat = (s: Stack) => s.filter((x) => x.kind === 'block').map((x) => `${(x as StackBlock).title}:${x.dur}:${(x as StackBlock).status}`);
                if (back.overlaps.length || JSON.stringify(flat(back.items)) !== JSON.stringify(flat(l)) || JSON.stringify(M.startsOf(back.items).filter((_, k) => back.items[k].kind === 'block')) !== JSON.stringify(M.startsOf(l).filter((_, k) => l[k].kind === 'block'))) {
                  fail(`povratak fromBlocks(toBlocks) se razlikuje (${tag})`);
                }
              }

              // --- pravilo talasa (ništa se ne preuređuje samo od sebe) ---
              if (expect) {
                const want = expect;
                const ns0 = M.startsOf(l);
                l.forEach((x, k) => {
                  if (x.kind !== 'block' || x.id === exceptId || !want.has(x.id)) return;
                  if (want.get(x.id) !== ns0[k]) fail(`talas: ${String(x.id)} ${want.get(x.id)} ≠ ${ns0[k]} (${tag})`);
                });
              }

              // --- prošlost ---
              const ps = M.startsOf(prev);
              const ns = M.startsOf(l);
              const pStart = new Map(prev.map((x, k) => [x.id, ps[k]]));
              if (split) {
                // Deljenje: ostali blokovi ne menjaju ni početak ni trajanje.
                l.forEach((x, k) => {
                  if (x.kind === 'block' && pStart.has(x.id) && x.id !== c.id && (pStart.get(x.id) !== ns[k] || prevDur.get(x.id) !== x.dur)) fail(`deljenje je pomerilo drugi blok (${tag})`);
                });
              } else if (A && Number.isFinite(A.now)) {
                l.forEach((x, k) => {
                  if (x.kind !== 'block') return;
                  if (ns[k] < A.now && pStart.get(x.id) !== ns[k]) fail(`nov/pomeren blok pre sada (${tag})`);
                  if (sd.grid && pStart.get(x.id) !== ns[k] && ns[k] < A.nows) fail(`nov/pomeren blok pre nows (${tag})`);
                });
                prev.forEach((x, k) => {
                  if (x.kind !== 'block' || x.status === 'pending' || ps[k] > A.now) return;
                  const j = M.idxOf(l, x.id);
                  if (j < 0 || l[j].kind !== 'block') return; // obrisan (slobodno vreme sa istim id-jem)
                  if (ns[j] !== ps[k]) fail(`ocenjen blok pomeren (${tag})`);
                  if (ps[k] + x.dur <= A.now && l[j].dur !== x.dur) fail(`prošao ocenjen blok promenio kraj (${tag})`);
                });
              } else if (A) {
                // Raniji dan: ništa se ne pomera, ništa novo.
                l.forEach((x, k) => {
                  if (x.kind !== 'block') return;
                  if (!pStart.has(x.id)) fail(`nov blok na ranijem danu (${tag})`);
                  else if (pStart.get(x.id) !== ns[k] || prevDur.get(x.id) !== x.dur) fail(`blok pomeren na ranijem danu (${tag})`);
                });
              }
            }
          }
        }
      }
    }
    assert.deepEqual(fails, []);
    assert.ok(applied >= 50_000, `primenjeno ${applied} izmena (odbijeno pastOk: ${refused})`);
    console.log(`nasumični test: primenjeno ${applied} izmena, pastOk odbio ${refused}`);
  });
});

