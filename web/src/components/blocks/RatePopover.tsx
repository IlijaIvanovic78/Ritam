// Izbor ocene uz krug na kartici (dodir na ocenjen krug ili držanje bilo kog): Urađeno / Delimično / Nije, vodoravno
// levo od kruga i po njegovoj sredini, sa strelicom ka krugu. Pokriva samo svoju karticu, nikad naziv sledeće.
// Zatvara se dodirom van njega (taj dodir samo zatvara: ne bira blok, ne otvara list, ne pomera vreme), Esc
// (kontroler; fokus se vraća na krug), skrolom većim od 8 px i svakom izmenom.

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { BlockStatus } from '../../../../shared/types.ts';
import type { ItemId } from '../../../../shared/blockStack.ts';
import { useT, type MessageKey } from '../../i18n/index.ts';
import { Icon, cx } from '../../ui/index.ts';
import type { StackController } from './controller.ts';
import { clamp, guardTap } from './geometry.ts';

const OPTS: Array<{
  s: Exclude<BlockStatus, 'pending'>;
  icon: 'check' | 'half' | 'x';
  label: Extract<MessageKey, 'status.done' | 'status.partial' | 'blocks.rate.skippedShort'>;
}> = [
  { s: 'done', icon: 'check', label: 'status.done' },
  { s: 'partial', icon: 'half', label: 'status.partial' },
  { s: 'skipped', icon: 'x', label: 'blocks.rate.skippedShort' },
];

/** Klik koji sledi pritisku van izbora (taj pritisak je samo zatvorio izbor): proguta se. */
function swallowClick() {
  const kill = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  const done = () => {
    document.removeEventListener('click', kill, true);
    document.removeEventListener('pointerdown', done, true);
  };
  document.addEventListener('click', kill, true);
  // Pritisak bez klika (skrol, držanje): sledeći pritisak je nov dodir.
  window.setTimeout(() => document.addEventListener('pointerdown', done, true), 0);
  window.setTimeout(done, 1500);
}

/** Postavlja izbor levo od kruga (u koordinatama odeljka niza), u vidljivom delu između trake i lista bloka. */
function place(ctl: StackController, id: ItemId, pop: HTMLElement, arrow: HTMLElement | null) {
  const chk = ctl.boxOf(id)?.querySelector<HTMLElement>('.blk-check');
  const sec = ctl.bsEl;
  if (!chk || !sec) {
    pop.style.visibility = 'hidden';
    return;
  }
  pop.style.visibility = '';
  const cr = chk.getBoundingClientRect();
  const sr = sec.getBoundingClientRect();
  const stack = ctl.stackEl?.getBoundingClientRect() ?? sr;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const cy = cr.top + cr.height / 2;
  const b = ctl.band();
  const minTop = Math.max(ctl.stuckBarBottom(), b.top) + 4;
  const top = clamp(cy - ph / 2, minTop, Math.max(minTop, b.bottom - ph - 4));
  // Desna ivica 4 px levo od kruga; ako ne staje, pomera se udesno preko kruga (tada bez strelice).
  const want = cr.left - 4 - pw;
  const left = Math.max(want, stack.left + 4);
  pop.style.left = `${left - sr.left}px`;
  pop.style.top = `${top - sr.top}px`;
  if (arrow) {
    arrow.hidden = left > want + 0.5;
    arrow.style.top = `${clamp(cy - top - 5, 10, ph - 20)}px`;
  }
}

export function RatePopover({ ctl }: { ctl: StackController }) {
  const t = useT();
  const id = ctl.ratePop;
  const found = id != null ? ctl.items.find((x) => x.id === id) : undefined;
  const c = found?.kind === 'block' ? found : null;
  const ref = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);

  // Posle svakog crtanja (minut "sada", promena visine reda): ponovo uz krug.
  useLayoutEffect(() => {
    if (id != null && ref.current) place(ctl, id, ref.current, arrowRef.current);
  });

  // Otvaranje: fokus na izabranu ocenu (ili prvu); dodir van izbora i skrol ga zatvaraju.
  useEffect(() => {
    const pop = ref.current;
    if (id == null || !pop) return;
    (pop.querySelector<HTMLElement>('[aria-pressed="true"]') ?? pop.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    const y0 = window.scrollY;
    // Pritisak van izbora ga samo zatvara: ne stiže do niza, koraka ni trake (ni klik posle njega).
    const onDown = (e: PointerEvent) => {
      if (pop.contains(e.target as Node)) return;
      e.stopPropagation();
      e.preventDefault();
      swallowClick();
      ctl.closeRatePop(false);
    };
    const onScroll = () => {
      if (Math.abs(window.scrollY - y0) > 8) ctl.closeRatePop(false);
    };
    const onResize = () => ctl.closeRatePop(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [ctl, id]);

  if (!c) return null;

  // ←/→ između ocena (Enter / razmak su obični klikovi dugmeta).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const btns = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
    const k = btns.indexOf(document.activeElement as HTMLElement);
    btns[clamp(k + (e.key === 'ArrowLeft' ? -1 : 1), 0, btns.length - 1)]?.focus();
  };

  return (
    <div
      ref={ref}
      className="blk-pop"
      role="dialog"
      aria-label={t('day.row.statusLabel', { title: c.title })}
      onKeyDown={onKey}
      onBlur={(e) => {
        // Tab van izbora ga zatvara (fokus ostaje gde je otišao). Ne i fokus na krug: dodir koji je držanjem otvorio
        // izbor po puštanju fokusira krug (Chrome).
        const to = e.relatedTarget as HTMLElement | null;
        if (to && !e.currentTarget.contains(to) && !to.closest('.blk-check')) ctl.closeRatePop(false);
      }}
    >
      {OPTS.map((o) => {
        const on = c.status === o.s;
        return (
          <button
            key={o.s}
            type="button"
            className={cx('blk-pop-opt', `is-${o.s}`, on && 'is-on')}
            aria-pressed={on}
            onClick={(e) => {
              // Izbor nestaje, a ispod je kartica: drugi dodir dvostrukog dodira bi je izabrao.
              guardTap(e);
              ctl.rate(c.id, o.s, 'pop');
              ctl.closeRatePop(false);
              ctl.focusCheck(c.id);
            }}
          >
            <span className="blk-pop-c">
              <Icon name={o.icon} size={16} />
            </span>
            <span className="blk-pop-l">{t(o.label)}</span>
          </button>
        );
      })}
      <span className="blk-pop-arrow" ref={arrowRef} aria-hidden="true" />
    </div>
  );
}
