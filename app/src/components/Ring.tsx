import { chanceOf } from '../lib/logic';

const UMFANG = 2 * Math.PI * 18;

/** Match als Ring: Füllung = Punkte von 100, Farbe = Chance. */
export function Ring({ score, why, gross = false }: { score: number | null; why: string | null; gross?: boolean }) {
  const c = chanceOf(why) ?? (score !== null && score >= 75 ? 'hoch' : score !== null && score >= 60 ? 'mittel' : 'niedrig');
  const p = Math.max(0, Math.min(100, score ?? 0)) / 100;
  return (
    <span className={`ring ${c}${gross ? ' gross' : ''}`} role="img" aria-label={`Match ${score ?? 'unbekannt'} von 100, Chance ${c}`}>
      <svg viewBox="0 0 40 40" aria-hidden="true"><circle className="spur" cx="20" cy="20" r="18" /><circle className="wert" cx="20" cy="20" r="18" style={{ strokeDasharray: UMFANG, strokeDashoffset: UMFANG * (1 - p) }} /></svg>
      {score ?? '?'}
    </span>
  );
}

