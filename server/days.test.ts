// Testovi `PUT /api/days/:date/blocks` na nivou repozitorijuma (baza u memoriji): zadržani id-jevi i ocene,
// brisanje i dodavanje u jednoj transakciji, vraćanje na grešku, odvojenost naloga, preklapanja, posle ponoći,
// pregled iz šablona, `base` i blokovi šablona iz uređivača "niz blokova". `npm test`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createBlockStack, fromBlocks, layoutBase, templateBase, toBlocks, toTemplateBlocks } from '../shared/blockStack.ts';
import { isoWeekday } from '../shared/time.ts';
import type { Block, DayBlockInput } from '../shared/types.ts';
import { openDatabase } from './db.ts';
import { repoFactory } from './repo.ts';
import type { Repo } from './repo.ts';
import { HttpError } from './util.ts';
import type { MsgKey } from './i18n.ts';

function setup(dayStart = 0): { db: DatabaseSync; A: Repo; B: Repo } {
  const db = openDatabase(':memory:');
  const ins = db.prepare('INSERT INTO users (email, password_hash, settings, created_at) VALUES (?, ?, ?, ?)');
  const settings = JSON.stringify({ dayStart, streakThreshold: 0.7, lang: 'en' });
  const at = new Date().toISOString();
  const a = Number(ins.run('a@example.test', 'x', settings, at).lastInsertRowid);
  const b = Number(ins.run('b@example.test', 'x', settings, at).lastInsertRowid);
  const repos = repoFactory(db);
  return { db, A: repos(a), B: repos(b) };
}

/** Greška sa statusom i ključem poruke (i parametrima). */
function throwsHttp(fn: () => unknown, status: number, key: MsgKey, params?: Record<string, unknown>) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status);
    assert.equal(e.key, key);
    if (params) assert.deepEqual(e.params, params);
    return true;
  });
}

const shape = (bs: Block[]) => bs.map((b) => [b.start, b.end, b.title, b.status, b.actualMin, b.note]);
const DATE = '2096-03-02';
const put = (r: Repo, blocks: DayBlockInput[], base?: string, date = DATE) => {
  r.putDayBlocks(date, blocks, base);
  return r.dayPayload(date);
};

describe('PUT /api/days/:date/blocks (repo.putDayBlocks)', () => {
  test('neinicijalizovan dan: inicijalizuje se iz šablona dana u nedelji, blokovi su iz tela', () => {
    const { A } = setup();
    A.addCategory({ name: 'Work', color: '#2f6db5', counts: true });
    const cat = A.listCategories()[0].id;
    const tpl = A.addTemplate('Workday', null);
    A.putTemplateBlocks(tpl, [{ start: 480, end: 720, title: 'Work', categoryId: cat }]);
    A.putWeekdays({ [isoWeekday(DATE)]: tpl });
    const preview = A.dayPayload(DATE);
    assert.equal(preview.initialized, false);
    assert.deepEqual(preview.blocks.map((b) => b.id), [-1]);
    // Pogrešan base: ništa se ne upisuje.
    throwsHttp(() => A.putDayBlocks(DATE, [], 'x'), 409, 'day.blocksChanged');
    assert.equal(A.dayPayload(DATE).initialized, false);
    // Raspored iz uređivača: deo pregleda + nov blok; base = pregled.
    const r = fromBlocks(preview.blocks, 0);
    const M = createBlockStack(r.frame);
    const split = M.opSplit(r.items, -1, [120]);
    assert.ok(split);
    const out = toBlocks(split.list, r.frame, { confirmed: preview.blocks });
    const d = put(A, out.blocks, layoutBase(preview.blocks));
    assert.equal(d.initialized, true);
    assert.equal(d.templateId, tpl);
    assert.equal(d.templateName, 'Workday');
    assert.deepEqual(d.blocks.map((b) => [b.start, b.end, b.title, b.categoryId]), [[480, 600, 'Work', cat], [600, 720, 'Work', cat]]);
    assert.ok(d.blocks.every((b) => b.id > 0));
    // Pregled sa drugim šablonom posle izmene nije bitan: dan je sada sačuvan.
    assert.equal(A.dayPayload(DATE).initialized, true);
  });

  test('zadržan id čuva ocenu, stvarno vreme i belešku; izostavljen se briše; nov se dodaje', () => {
    const { A } = setup();
    A.initDay(DATE, null);
    A.addBlock(DATE, { start: 480, end: 600, title: 'Work', categoryId: null });
    A.addBlock(DATE, { start: 600, end: 660, title: 'Rest', categoryId: null });
    A.addBlock(DATE, { start: 700, end: 760, title: 'Walk', categoryId: null });
    let d = A.dayPayload(DATE);
    const [work, rest, walk] = d.blocks;
    A.patchBlock(work.id, { status: 'done', actualMin: 100, note: 'good' });
    A.patchBlock(rest.id, { status: 'partial', actualMin: 20 });
    d = A.dayPayload(DATE);
    // Work se pomera kasnije (bez polja ocene), Rest ide pre njega, Walk se briše, Training je nov.
    d = put(A, [
      { id: rest.id, start: 480, end: 540, title: 'Rest', categoryId: null },
      { id: work.id, start: 540, end: 660, title: 'Work', categoryId: null },
      { start: 660, end: 720, title: 'Training', categoryId: null },
    ]);
    assert.deepEqual(shape(d.blocks), [
      [480, 540, 'Rest', 'partial', 20, ''],
      [540, 660, 'Work', 'done', 100, 'good'],
      [660, 720, 'Training', 'pending', null, ''],
    ]);
    assert.equal(d.blocks[0].id, rest.id);
    assert.equal(d.blocks[1].id, work.id);
    assert.ok(d.blocks[2].id > walk.id);
    assert.ok(!d.blocks.some((b) => b.id === walk.id));
    throwsHttp(() => A.patchBlock(walk.id, { status: 'done' }), 404, 'block.notFound');

    // Poslata polja ocene važe; 'skipped' bez stvarnog vremena ga briše; kraće od stvarnog vremena → null.
    d = put(A, [
      { id: rest.id, start: 480, end: 540, title: 'Rest', categoryId: null, status: 'skipped' },
      { id: work.id, start: 540, end: 630, title: 'Work', categoryId: null, note: 'changed' },
      { id: d.blocks[2].id, start: 660, end: 720, title: 'Training', categoryId: null, status: 'done', actualMin: 45 },
    ]);
    assert.deepEqual(shape(d.blocks), [
      [480, 540, 'Rest', 'skipped', null, ''],
      [540, 630, 'Work', 'done', null, 'changed'], // sačuvanih 100 min > 90 → null
      [660, 720, 'Training', 'done', 45, ''],
    ]);
    // Stvarno vreme duže od bloka (poslato) → 400; ništa se ne menja.
    const before = A.dayPayload(DATE);
    throwsHttp(() => A.putDayBlocks(DATE, [{ id: work.id, start: 540, end: 600, title: 'Work', categoryId: null, actualMin: 61 }]), 400, 'block.actualTooLong', { max: 60 });
    assert.deepEqual(A.dayPayload(DATE), before);
    // Prazan raspored briše sve blokove; dan ostaje inicijalizovan.
    d = put(A, []);
    assert.equal(d.initialized, true);
    assert.deepEqual(d.blocks, []);
  });

  test('greška vraća sve (nepostojeći id, preklapanje, dupli id): ništa se ne menja', () => {
    const { A } = setup();
    const empty = A.dayPayload(DATE);
    throwsHttp(() => A.putDayBlocks(DATE, [{ start: 480, end: 540, title: 'New', categoryId: null }, { id: 999999, start: 600, end: 660, title: 'X', categoryId: null }]), 400, 'block.notFound');
    assert.deepEqual(A.dayPayload(DATE), empty);
    assert.equal(A.dayRow(DATE), undefined);

    A.initDay(DATE, null);
    A.addBlock(DATE, { start: 480, end: 540, title: 'A', categoryId: null });
    const before = A.dayPayload(DATE);
    const id = before.blocks[0].id;
    throwsHttp(() => A.putDayBlocks(DATE, [{ id, start: 480, end: 540, title: 'A', categoryId: null }, { start: 530, end: 600, title: 'B', categoryId: null }]), 400, 'block.overlap', { a: 'A', b: 'B' });
    throwsHttp(() => A.putDayBlocks(DATE, [{ start: 480, end: 900, title: 'Long', categoryId: null }, { start: 500, end: 520, title: 'In', categoryId: null }, { start: 880, end: 920, title: 'Out', categoryId: null }]), 400, 'block.overlap', { a: 'Long', b: 'In' });
    throwsHttp(() => A.putDayBlocks(DATE, [{ id, start: 480, end: 540, title: 'A', categoryId: null }, { id, start: 600, end: 660, title: 'A', categoryId: null }]), 400, 'block.duplicate');
    throwsHttp(() => A.putDayBlocks(DATE, [{ start: 480, end: 540, title: 'A', categoryId: 424242 }]), 400, 'category.notFound');
    assert.deepEqual(A.dayPayload(DATE), before);
    // Kraj jednog = početak drugog nije preklapanje.
    const d = put(A, [{ id, start: 480, end: 540, title: 'A', categoryId: null }, { start: 540, end: 600, title: 'B', categoryId: null }]);
    assert.equal(d.blocks.length, 2);
  });

  test('odvojenost naloga: tuđ id ili tuđa kategorija → 400, ništa se ne menja', () => {
    const { A, B } = setup();
    A.addCategory({ name: 'Mine', color: '#336699', counts: true });
    const catA = A.listCategories()[0].id;
    A.initDay(DATE, null);
    A.addBlock(DATE, { start: 480, end: 540, title: 'A secret', categoryId: catA });
    A.patchBlock(A.dayPayload(DATE).blocks[0].id, { status: 'done', note: 'secret' });
    const aBefore = A.dayPayload(DATE);
    const aId = aBefore.blocks[0].id;
    throwsHttp(() => B.putDayBlocks(DATE, [{ id: aId, start: 480, end: 540, title: 'stolen', categoryId: null }]), 400, 'block.notFound');
    throwsHttp(() => B.putDayBlocks(DATE, [{ start: 480, end: 540, title: 'X', categoryId: catA }]), 400, 'category.notFound');
    // Tuđi id na drugom datumu istog naloga je isto "ne postoji".
    throwsHttp(() => A.putDayBlocks('2096-03-03', [{ id: aId, start: 480, end: 540, title: 'moved', categoryId: null }]), 400, 'block.notFound');
    const b = put(B, [{ start: 600, end: 660, title: 'B own', categoryId: null }]);
    assert.deepEqual(b.blocks.map((x) => x.title), ['B own']);
    assert.deepEqual(A.dayPayload(DATE), aBefore);
    // B prazni svoj dan: A-ov dan ostaje.
    put(B, []);
    assert.deepEqual(A.dayPayload(DATE), aBefore);
    // Isti datum, različiti nalozi, različit base.
    assert.notEqual(layoutBase(A.dayPayload(DATE).blocks), layoutBase(B.dayPayload(DATE).blocks));
  });

  test('posle ponoći: blok preko ponoći i blok 00:00–01:00 na kraju dana (dayStart 60)', () => {
    const { A } = setup(60);
    A.initDay(DATE, null);
    const d = put(A, [
      { start: 60, end: 540, title: 'Sleep', categoryId: null },
      { start: 1380, end: 1440, title: 'Late', categoryId: null },
      { start: 1440, end: 1500, title: 'After midnight', categoryId: null },
    ]);
    assert.deepEqual(d.blocks.map((b) => [b.start, b.end]), [[60, 540], [1380, 1440], [1440, 1500]]);
    const r = fromBlocks(d.blocks, 60);
    assert.deepEqual(r.overlaps, []);
    assert.equal(createBlockStack(r.frame).total(r.items), 1440);
    const over = put(A, [{ start: 1410, end: 1530, title: 'Overnight', categoryId: null }]);
    assert.deepEqual(over.blocks.map((b) => [b.start, b.end]), [[1410, 1530]]);
  });

  test('base: ista lista prolazi, izmena sa drugog uređaja → 409', () => {
    const { A } = setup();
    A.initDay(DATE, null);
    A.addBlock(DATE, { start: 480, end: 540, title: 'A', categoryId: null });
    const seen = A.dayPayload(DATE);
    const id = seen.blocks[0].id;
    const d = put(A, [{ id, start: 495, end: 555, title: 'A', categoryId: null }], layoutBase(seen.blocks));
    // Drugi uređaj je u međuvremenu ocenio blok.
    A.patchBlock(id, { status: 'done' });
    throwsHttp(() => A.putDayBlocks(DATE, [{ id, start: 600, end: 660, title: 'A', categoryId: null }], layoutBase(d.blocks)), 409, 'day.blocksChanged');
    assert.equal(A.dayPayload(DATE).blocks[0].start, 495);
    // Sa svežim stanjem prolazi i ocena ostaje.
    const fresh = A.dayPayload(DATE);
    const after = put(A, [{ id, start: 600, end: 660, title: 'A', categoryId: null }], layoutBase(fresh.blocks));
    assert.deepEqual(shape(after.blocks), [[600, 660, 'A', 'done', null, '']]);
  });

  test('obrisana kategorija: zadržava je blok koji je ima i delovi podeljenog bloka; nov blok je ne može dobiti', () => {
    const { A } = setup();
    A.addCategory({ name: 'Old', color: '#445566', counts: true });
    A.addCategory({ name: 'Other', color: '#112233', counts: true });
    const [oldCat, otherCat] = A.listCategories().map((c) => c.id);
    A.initDay(DATE, null);
    A.addBlock(DATE, { start: 480, end: 600, title: 'Old work', categoryId: oldCat });
    A.addBlock(DATE, { start: 700, end: 760, title: 'X', categoryId: otherCat });
    A.deleteCategory(oldCat);
    A.deleteCategory(otherCat);
    const day = A.dayPayload(DATE);
    const [old, x] = day.blocks;
    const d = put(A, [
      { id: old.id, start: 480, end: 540, title: 'Old work', categoryId: oldCat },
      { start: 540, end: 600, title: 'Old work', categoryId: oldCat },
      { id: x.id, start: 700, end: 760, title: 'X', categoryId: otherCat },
    ]);
    assert.deepEqual(d.blocks.map((b) => b.categoryId), [oldCat, oldCat, otherCat]);
    const other = '2096-03-04';
    throwsHttp(() => A.putDayBlocks(other, [{ start: 540, end: 600, title: 'New', categoryId: oldCat }]), 400, 'category.notFound');
  });

  test('raspored iz uređivača ide kroz PUT šablona tačno kakav jeste (bez ocena, id-jeva)', () => {
    const { A } = setup(60);
    const tpl = A.addTemplate('Workday', null);
    // Šablon iz niza: od 01:00, blok preko ponoći na kraju dana.
    const M = createBlockStack(60);
    const items = M.normalize([
      { kind: 'block', id: 'n1', title: 'Sleep', categoryId: null, dur: 420, status: 'pending', actualMin: null, note: '' },
      { kind: 'free', id: 'f1', dur: 60 },
      { kind: 'block', id: 'n2', title: 'Work', categoryId: null, dur: 480, status: 'pending', actualMin: null, note: '' },
      { kind: 'free', id: 'f2', dur: 420 },
      { kind: 'block', id: 'n3', title: 'Read', categoryId: null, dur: 90, status: 'pending', actualMin: null, note: '' },
    ]);
    const out = toTemplateBlocks(items, M.frame);
    assert.deepEqual(out.invalid, []);
    A.putTemplateBlocks(tpl, out.blocks);
    const saved = A.listTemplates()[0].blocks;
    assert.deepEqual(saved.map((b) => [b.start, b.end, b.title]), [[60, 480, 'Sleep'], [540, 1020, 'Work'], [1440, 1530, 'Read']]);
    const back = fromBlocks(saved, 60);
    assert.deepEqual(back.overlaps, []);
    assert.deepEqual(toTemplateBlocks(back.items, back.frame).blocks, out.blocks);
  });

  test('blokovi šablona: base = sadržaj na koji se izmena oslanja; drugačiji šablon → 409 i ništa se ne menja', () => {
    const { A, B } = setup();
    const tpl = A.addTemplate('Workday', null);
    const first = [{ start: 480, end: 600, title: 'Work', categoryId: null }];
    // Bez base: bezuslovno (kao i ranije).
    A.putTemplateBlocks(tpl, first);
    let saved = A.listTemplates()[0].blocks;
    const base = templateBase(saved);
    assert.equal(base, templateBase(first));
    // Isti base posle čuvanja (novi id-jevi) i dalje važi.
    const second = [...first, { start: 600, end: 660, title: 'Lunch', categoryId: null }];
    A.putTemplateBlocks(tpl, second, base);
    saved = A.listTemplates()[0].blocks;
    assert.deepEqual(saved.map((b) => b.title), ['Work', 'Lunch']);
    // Zastareo base (drugi uređaj je u međuvremenu sačuvao): 409, šablon ostaje.
    throwsHttp(() => A.putTemplateBlocks(tpl, [], base), 409, 'template.blocksChanged');
    assert.deepEqual(A.listTemplates()[0].blocks.map((b) => b.title), ['Work', 'Lunch']);
    A.putTemplateBlocks(tpl, [], templateBase(saved));
    assert.deepEqual(A.listTemplates()[0].blocks, []);
    // Tuđi šablon: 404 i sa ispravnim base-om.
    throwsHttp(() => B.putTemplateBlocks(tpl, first, templateBase([])), 404, 'template.notFound');
  });
});
