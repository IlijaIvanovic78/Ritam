// Legenda za heatmape: "manje … više" + nepraćeni dani.

import { HEAT_RANGES, heatClass, type HeatLevel } from './period.ts';

const LEVELS: HeatLevel[] = [0, 1, 2, 3, 4];

/** live = prikazan je dan u toku (neutralna ćelija sa okvirom). */
export function HeatLegend({ live = false }: { live?: boolean }) {
  return (
    <div className="prog-legend">
      <span className="prog-legend-item">
        manje
        <span className="prog-legend-scale">
          {LEVELS.map((l) => (
            <span key={l} className={`prog-swatch ${heatClass(l)}`} title={HEAT_RANGES[l]} aria-hidden="true" />
          ))}
        </span>
        više
      </span>
      <span className="prog-legend-item">
        <span className={`prog-swatch ${heatClass(null)}`} aria-hidden="true" />
        nije praćeno
      </span>
      {live && (
        <span className="prog-legend-item">
          <span className="prog-swatch prog-heat-live" aria-hidden="true" />u toku
        </span>
      )}
    </div>
  );
}
