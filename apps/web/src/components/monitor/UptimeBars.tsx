import { useId } from "react";
import type { MonitorHistoryPoint } from "@hub/contract";
import { dailyStats, formatDay } from "@/lib/monitor";
import { formatDecimal, plural } from "@/lib/format";
import { Explain } from "@/components/ui/InfoTip";

/** Géométrie du SVG (unités du viewBox) : barre et espace de 2 entre barres. */
const BAR = 8;
const GAP = 2;
const H = 24;

function tone(rate: number | null): string {
  if (rate == null) return "var(--surface-hover)";
  if (rate >= 100) return "var(--success)";
  if (rate >= 99) return "var(--warning)";
  return "var(--danger)";
}

/**
 * Historique de 30 jours : une barre par jour (contrôles réussis des deux points de contrôle). La couleur
 * n'est jamais seule : résumé en texte, infobulle par barre, légende dans l'explication « ? » et tableau
 * pour les lecteurs d'écran.
 */
export function UptimeBars({ history, days = 30 }: { history: MonitorHistoryPoint[]; days?: number }) {
  const ids = useId();
  const stats = dailyStats(history, days);
  const measured = stats.filter((d) => d.rate != null);
  const bad = measured.filter((d) => (d.rate ?? 100) < 100);
  const width = days * (BAR + GAP) - GAP;
  const summary = !measured.length
    ? "Pas encore de contrôles enregistrés sur la période."
    : bad.length === 0
      ? `${plural(measured.length, "jour contrôlé", "jours contrôlés")}, aucun échec.`
      : `${plural(measured.length, "jour contrôlé", "jours contrôlés")}, dont ${plural(bad.length, "jour", "jours")} avec des échecs : ${bad
          .slice(-3)
          .map((d) => formatDay(d.day))
          .join(", ")}${bad.length > 3 ? "…" : ""}.`;

  return (
    <div className="space-y-1.5">
      <svg
        viewBox={`0 0 ${width} ${H}`}
        preserveAspectRatio="none"
        className="block h-6 w-full"
        role="img"
        aria-label={`Contrôles réussis, jour par jour, sur ${days} jours`}
        aria-describedby={`${ids}-sum`}
      >
        {stats.map((d, i) => (
          <rect key={d.day} x={i * (BAR + GAP)} y={0} width={BAR} height={H} rx={2} fill={tone(d.rate)}>
            <title>
              {formatDay(d.day)} :{" "}
              {d.rate == null ? "pas de contrôle" : `${formatDecimal(d.rate, 2)} % (${d.failures} échec(s) sur ${d.checks})`}
            </title>
          </rect>
        ))}
      </svg>
      <p className="flex items-start gap-1 text-xs text-[var(--muted)]">
        <span id={`${ids}-sum`}>{summary}</span>
        <Explain k="bars" />
      </p>
      <table className="sr-only">
        <caption>Contrôles réussis par jour</caption>
        <thead>
          <tr>
            <th scope="col">Jour</th>
            <th scope="col">Réussite</th>
            <th scope="col">Échecs</th>
          </tr>
        </thead>
        <tbody>
          {measured.map((d) => (
            <tr key={d.day}>
              <th scope="row">{formatDay(d.day)}</th>
              <td>{formatDecimal(d.rate ?? 0, 2)} %</td>
              <td>
                {d.failures} sur {d.checks}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
