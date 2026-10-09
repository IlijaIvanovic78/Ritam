// Legenda za heatmape: "manje … više" + nepraćeni dani.

import { useT } from '../../i18n/index.ts';
import { HEAT_RANGES, heatClass, type HeatLevel } from './period.ts';

const LEVELS: HeatLevel[] = [0, 1, 2, 3, 4];

/** live = prikazan je dan u toku (neutralna ćelija sa okvirom). */
export function HeatLegend({ live = false }: { live?: boolean }) {
  const t = useT();
  return (
    <div className="prog-legend">
      <span className="prog-legend-item">
        {t('progress.legend.less')}
        <span className="prog-legend-scale">
          {LEVELS.map((l) => (
            <span key={l} className={`prog-swatch ${heatClass(l)}`} title={HEAT_RANGES[l]} aria-hidden="true" />
          ))}
        </span>
        {t('progress.legend.more')}
      </span>
      <span className="prog-legend-item">
        <span className={`prog-swatch ${heatClass(null)}`} aria-hidden="true" />
        {t('progress.notTracked')}
      </span>
      {live && (
        <span className="prog-legend-item">
          <span className="prog-swatch prog-heat-live" aria-hidden="true" />
          {t('progress.live')}
        </span>
      )}
    </div>
  );
}
