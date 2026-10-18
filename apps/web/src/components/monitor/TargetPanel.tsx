import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faFilePdf, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import type { MonitorIncidentEntry, MonitorTargetDetail, MonitorTargetEntry, Page } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatAgo, formatBytes, formatDate, formatDateTime, formatDecimal, plural } from "@/lib/format";
import {
  basisLabel,
  EXPIRY_WARN_DAYS,
  formatDuration,
  formatMs,
  formatSince,
  formatUptime,
  VERDICT,
} from "@/lib/monitor";
import type { GlossaryKey } from "@/lib/glossary";
import { useResource } from "@/lib/useResource";
import { Badge } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Banner } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Explain } from "@/components/ui/InfoTip";
import { Tile } from "@/components/ui/Tile";
import { UptimeBars } from "@/components/monitor/UptimeBars";

const SOURCE: Record<MonitorTargetEntry["source"], string> = {
  site: "Site du hub",
  cloudflare: "Domaine Cloudflare",
  manual: "Ajouté à la main",
};

const VERDICT_TIP: Partial<Record<MonitorTargetEntry["verdict"], GlossaryKey>> = {
  down: "down",
  local_only: "localOnly",
  edge_only: "edgeOnly",
};

/** Incidents montrés dans la tuile ; la liste complète est paginée sur /surveillance/incidents. */
const INCIDENTS_SHOWN = 5;

type LastCheck = MonitorTargetEntry["lastHub"];

function checkText(c: LastCheck): string {
  if (!c) return "Pas encore de contrôle.";
  const when = formatAgo(c.at);
  if (c.ok) return `Réussi ${when}${c.status ? `, réponse ${c.status}` : ""}, ${formatMs(c.ms)}.`;
  return `Échec ${when}${c.reason ? ` : ${c.reason}` : c.status ? ` : réponse ${c.status}` : ""}.`;
}

function basisTip(basis: Array<"hub" | "edge">): GlossaryKey | null {
  const hub = basis.includes("hub");
  const edge = basis.includes("edge");
  return hub && edge ? "basisBoth" : hub ? "basisHub" : edge ? "basisEdge" : null;
}

/** Morceaux joints par des virgules, majuscule initiale et point final ; undefined si tout est vide. */
function sentence(parts: Array<string | null | undefined>): string | undefined {
  const text = parts.filter(Boolean).join(", ");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : undefined;
}

const toneInk = { bad: "text-[var(--danger)]", warn: "text-[var(--warning)]" } as const;

/** Valeur principale d'une tuile et sa ligne de détail. */
function Value({ main, detail, tone }: { main: ReactNode; detail?: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="min-w-0">
      <p className={`tile-value break-words ${tone ? toneInk[tone] : ""}`}>{main}</p>
      {detail ? <p className="mt-0.5 break-words text-xs text-[var(--muted)]">{detail}</p> : null}
    </div>
  );
}

/** Mesure de vitesse : sigle, explication et valeur. */
function Metric({ label, tip, value }: { label: string; tip: GlossaryKey; value: string }) {
  return (
    <div className="flex min-h-6 min-w-0 flex-wrap items-center justify-between gap-x-2">
      <dt className="flex items-center gap-0.5 text-xs text-[var(--muted)]">
        {label}
        <Explain k={tip} />
      </dt>
      <dd className="text-sm font-semibold text-[var(--text)]">{value}</dd>
    </div>
  );
}

/**
 * Une cible surveillée en grille bento : grande tuile d'état (interrupteur, verdict, point de vue, derniers
 * contrôles, « Contrôler maintenant »), puis disponibilité et barre des 30 jours, certificat, domaine, DNS et
 * contenu (avec « Accepter comme référence »), vitesse, incidents et rapports mensuels.
 */
export function TargetPanel({
  target,
  onChange,
  headingLevel = 2,
  showSiteLink = false,
  hideOrigin = false,
}: {
  target: MonitorTargetEntry;
  onChange: (t: MonitorTargetEntry) => void;
  headingLevel?: 2 | 3;
  /** Page Surveillance : lien vers la fiche du site lié. */
  showSiteLink?: boolean;
  /** Fiche du site : origine et client sont déjà sur la page. */
  hideOrigin?: boolean;
}) {
  const ids = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const sub = headingLevel === 2 ? 3 : 4;
  const detail = useResource<MonitorTargetDetail>(`/api/monitor/targets/${target.id}?days=30`, null, { keepData: true });
  const reloadDetail = detail.reload;
  // Derniers incidents de l'adresse ; la liste complète est paginée sur /surveillance/incidents.
  const incidents = useResource<Page<MonitorIncidentEntry>>(`/api/monitor/incidents?targetId=${target.id}&pageSize=${INCIDENTS_SHOWN}`, null, { keepData: true });
  const reloadIncidents = incidents.reload;
  const [busy, setBusy] = useState<"switch" | "check" | "accept" | null>(null);
  const [accept, setAccept] = useState<"dns" | "content" | null>(null);
  const t = target;
  const look = VERDICT[t.verdict];

  // Cible changée (contrôle, interrupteur, référence) : historique et incidents relus.
  const signature = `${t.lastHub?.at}|${t.lastEdge?.at}|${t.enabled}|${t.openIncident?.id}|${t.dns?.status}|${t.content?.status}`;
  useEffect(() => {
    void reloadDetail();
    void reloadIncidents();
  }, [signature, reloadDetail, reloadIncidents]);

  async function run(kind: "switch" | "check" | "accept", call: () => Promise<MonitorTargetEntry>, ok: string) {
    setBusy(kind);
    try {
      onChange(await call());
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const certTone = t.certificate ? (!t.certificate.ok ? "bad" : t.certificate.daysLeft <= EXPIRY_WARN_DAYS ? "warn" : undefined) : undefined;
  const domainTone = t.domainExpiry?.daysLeft != null && t.domainExpiry.daysLeft <= EXPIRY_WARN_DAYS ? "warn" : undefined;
  const dnsTone = t.dns?.status === "drift" || t.dns?.status === "error" ? "warn" : undefined;
  const contentTone = t.content?.status === "changed" || t.content?.status === "error" ? "warn" : undefined;
  const statusTone = !t.enabled ? undefined : t.verdict === "down" ? "bad" : t.verdict === "local_only" || t.verdict === "edge_only" ? "warn" : undefined;
  // Mois en cours : rapport fabriqué à la demande par le hub (le rapport complet est créé le 1er du mois suivant).
  const thisMonth = new Date().toISOString().slice(0, 7);
  const listed = detail.data?.reports ?? [];
  const reports = listed.some((r) => r.month === thisMonth) ? listed : [{ id: "current", month: thisMonth, createdAt: "" }, ...listed];

  const verdictTip = VERDICT_TIP[t.verdict];
  const pointTip = basisTip(t.basis);

  const acceptButton = (kind: "dns" | "content") => (
    <Button variant="secondary" className="self-start" onClick={() => setAccept(kind)} disabled={busy !== null}>
      Accepter comme référence
    </Button>
  );

  // Historique (disponibilité, incidents, rapports) : lu à part, avec ses états.
  const historyState = detail.error && !detail.data ? "error" : !detail.data ? "loading" : "ready";
  const historyPending =
    historyState === "loading" ? (
      <p role="status" className="text-sm text-[var(--muted)]">
        Lecture de l'historique…
      </p>
    ) : historyState === "error" ? (
      <p className="text-sm text-[var(--muted)]">Historique indisponible.</p>
    ) : null;

  return (
    <>
      <div className="bento">
        <section className="tile tile-full" data-tone={statusTone} aria-labelledby={`${ids}-title`}>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div className="min-w-0 flex-[1_1_16rem]">
              <Heading id={`${ids}-title`} className="break-words text-base font-semibold">
                {t.label}
              </Heading>
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--muted)]">
                <a href={t.url} target="_blank" rel="noopener noreferrer" className="link inline-flex min-h-6 items-center gap-1.5 break-all font-mono">
                  {t.hostname}
                  <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="sr-only">(nouvel onglet)</span>
                </a>
                {hideOrigin ? null : <span>{SOURCE[t.source]}</span>}
                {t.clientName && !hideOrigin ? <span>{t.clientName}</span> : null}
                {showSiteLink && t.siteId ? (
                  <Link to={`/sites/${t.siteId}?tab=surveillance`} className="link">
                    Fiche du site
                  </Link>
                ) : null}
              </p>
            </div>
            <div className="w-full sm:w-40">
              <Switch
                checked={t.enabled}
                onChange={(next) =>
                  void run(
                    "switch",
                    () => api<MonitorTargetEntry>(`/api/monitor/targets/${t.id}`, { method: "PATCH", json: { enabled: next } }),
                    next ? "Surveillance activée" : "Surveillance coupée",
                  )
                }
                label="Surveillé"
                stateLabels={{ on: "Oui", off: "Non" }}
                disabled={busy !== null}
              />
            </div>
          </div>

          {t.enabled ? (
            <>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <Badge tone={look.tone}>
                  <FontAwesomeIcon icon={look.icon} className="h-3 w-3" aria-hidden />
                  {t.verdict === "down" && t.openIncident ? `Panne depuis ${formatSince(t.openIncident.startedAt)}` : look.label}
                </Badge>
                {verdictTip ? <Explain k={verdictTip} /> : null}
                <span className="ml-1 text-sm text-[var(--muted)]">{basisLabel(t.basis)}</span>
                {pointTip ? <Explain k={pointTip} /> : null}
              </p>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <dl className="min-w-0 flex-[1_1_20rem] space-y-0.5 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-1.5">
                    <dt className="inline-flex items-center gap-0.5 text-[var(--muted)]">
                      Hub
                      <Explain k="hub" />
                    </dt>
                    <dd className={`min-w-0 break-words ${t.lastHub && !t.lastHub.ok ? toneInk.bad : "text-[var(--text)]"}`}>{checkText(t.lastHub)}</dd>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-1.5">
                    <dt className="inline-flex items-center gap-0.5 text-[var(--muted)]">
                      Cloudflare
                      <Explain k="worker" />
                    </dt>
                    <dd className={`min-w-0 break-words ${t.lastEdge && !t.lastEdge.ok ? toneInk.bad : "text-[var(--text)]"}`}>{checkText(t.lastEdge)}</dd>
                  </div>
                </dl>
                <Button
                  variant="secondary"
                  className="max-sm:w-full"
                  onClick={() =>
                    void run("check", () => api<MonitorTargetEntry>(`/api/monitor/targets/${t.id}/check`, { method: "POST" }), "Contrôle effectué")
                  }
                  disabled={busy !== null}
                >
                  <FontAwesomeIcon icon={faRotateRight} className="h-3.5 w-3.5" aria-hidden />
                  {busy === "check" ? "Contrôle…" : "Contrôler maintenant"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">Surveillance coupée : aucun contrôle ni alerte pour cette adresse. L'historique est gardé.</p>
          )}
        </section>

        {t.enabled ? (
          // Tuiles chiffrées courtes : deux par ligne au téléphone (150 px au moins chacune), quatre au bureau.
          <div className="bento-compact">
            <Tile title="Disponibilité" level={sub} tip="uptime">
              <dl className="space-y-0.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <dt className="text-xs text-[var(--muted)]">30 jours</dt>
                  <dd className="tile-value">{formatUptime(t.uptime30d) ?? "trop tôt"}</dd>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <dt className="text-xs text-[var(--muted)]">24 h</dt>
                  <dd className="tile-value">{formatUptime(t.uptime24h) ?? "trop tôt"}</dd>
                </div>
              </dl>
            </Tile>

            <Tile title="Certificat" level={sub} tip="tls" tone={certTone}>
              {!t.certificate ? (
                <p className="text-sm text-[var(--muted)]">Pas encore contrôlé.</p>
              ) : !t.certificate.ok ? (
                <Value main="Invalide" detail={t.certificate.error ?? undefined} tone="bad" />
              ) : (
                <Value
                  main={plural(t.certificate.daysLeft, "jour", "jours")}
                  detail={sentence([`fin le ${formatDate(t.certificate.validTo)}`, t.certificate.issuer])}
                  tone={certTone}
                />
              )}
            </Tile>

            <Tile title="Domaine" level={sub} tip="rdap" tone={domainTone}>
              {!t.domainExpiry ? (
                <p className="text-sm text-[var(--muted)]">Pas encore contrôlé.</p>
              ) : t.domainExpiry.expiresAt ? (
                <Value
                  main={t.domainExpiry.daysLeft != null ? plural(t.domainExpiry.daysLeft, "jour", "jours") : formatDate(t.domainExpiry.expiresAt)}
                  detail={sentence([`fin le ${formatDate(t.domainExpiry.expiresAt)}`, t.domainExpiry.registrar])}
                  tone={domainTone}
                />
              ) : (
                <Value main="Inconnue" detail="Le registre ne publie pas l'échéance." />
              )}
            </Tile>

            <Tile title="Vitesse (téléphone)" level={sub} tip="speed">
              {!t.speed ? (
                <p className="text-sm text-[var(--muted)]">Pas encore mesurée (une mesure par semaine).</p>
              ) : t.speed.ttfbMs == null && t.speed.lcpMs == null ? (
                <Value main="Impossible" detail={`Accueil injoignable, essai ${formatAgo(t.speed.measuredAt)}.`} />
              ) : (
                <>
                  <dl className="space-y-0.5">
                    <Metric label="TTFB" tip="ttfb" value={formatMs(t.speed.ttfbMs)} />
                    <Metric label="LCP" tip="lcp" value={formatMs(t.speed.lcpMs)} />
                    <Metric label="CLS" tip="cls" value={t.speed.cls != null ? formatDecimal(t.speed.cls, 2) : "inconnu"} />
                  </dl>
                  <p className="text-xs text-[var(--muted)]">
                    {sentence([
                      t.speed.requests != null ? `${t.speed.requests} requêtes` : null,
                      t.speed.bytes != null ? formatBytes(t.speed.bytes) : null,
                      `mesurée ${formatAgo(t.speed.measuredAt)}`,
                    ])}
                  </p>
                </>
              )}
            </Tile>
          </div>
        ) : null}

        <Tile title="Historique sur 30 jours" level={sub} tip="bars" span={2}>
          {historyState === "error" ? (
            <Banner level="error" action={<Button variant="ghost" onClick={() => void detail.reload()}>Réessayer</Button>}>
              {detail.error}
            </Banner>
          ) : detail.data ? (
            <UptimeBars history={detail.data.history} />
          ) : (
            historyPending
          )}
        </Tile>

        {t.enabled ? (
          <>
            <Tile title="DNS" level={sub} tip="dns" tone={dnsTone}>
              {!t.dns ? (
                <p className="text-sm text-[var(--muted)]">Pas encore contrôlé.</p>
              ) : t.dns.status === "ok" ? (
                <Value main="Conforme" detail="Identique à la référence." />
              ) : t.dns.status === "drift" ? (
                <Value main="Différent de la référence" detail={t.dns.detail ?? undefined} tone="warn" />
              ) : t.dns.status === "no_reference" ? (
                <Value main="Pas encore de référence" />
              ) : (
                <Value main="Contrôle impossible" detail={t.dns.detail ?? undefined} tone="warn" />
              )}
              {!t.dns || t.dns.status === "drift" || t.dns.status === "no_reference" ? acceptButton("dns") : null}
            </Tile>

            <Tile title="Contenu de l'accueil" level={sub} tip="content" tone={contentTone}>
              {!t.content ? (
                <p className="text-sm text-[var(--muted)]">Pas encore contrôlé.</p>
              ) : t.content.status === "ok" ? (
                <Value main="Inchangé" detail="Identique à la référence." />
              ) : t.content.status === "changed" ? (
                <Value main="Changé" detail="Sans publication par le hub." tone="warn" />
              ) : t.content.status === "no_reference" ? (
                <Value main="Pas encore de référence" />
              ) : (
                <Value main="Contrôle impossible" tone="warn" />
              )}
              {!t.content || t.content.status === "changed" || t.content.status === "no_reference" ? acceptButton("content") : null}
            </Tile>
          </>
        ) : null}

        <Tile title="Incidents récents" level={sub} tip="incident">
          {incidents.error && !incidents.data ? (
            <p className="text-sm text-[var(--muted)]">Incidents indisponibles.</p>
          ) : !incidents.data ? (
            <p role="status" className="text-sm text-[var(--muted)]">
              Lecture des incidents…
            </p>
          ) : incidents.data.total === 0 ? (
              <p className="text-sm text-[var(--muted)]">Aucun incident enregistré.</p>
            ) : (
              <>
                <ul className="divide-y divide-[var(--border)]">
                  {incidents.data.items.map((i) => (
                    <li key={i.id} className="py-1.5 text-sm first:pt-0 last:pb-0">
                      <span className="text-[var(--text)]">
                        {formatDateTime(i.startedAt)}
                        {i.endedAt ? `, durée ${formatDuration(i.durationMs ?? 0)}` : ", en cours"}
                      </span>
                      <span className="block text-xs text-[var(--muted)]">
                        {i.cause ?? "Cause non précisée"} ; {basisLabel(i.basis)}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link to={`/surveillance/incidents?adresse=${t.id}`} className="link inline-flex min-h-11 items-center self-start text-sm font-medium">
                  {incidents.data.total > INCIDENTS_SHOWN ? `Tous les incidents (${incidents.data.total})` : "Tous les incidents"}
                </Link>
              </>
            )}
        </Tile>

        <Tile title="Rapports mensuels" level={sub} tip="report">
          {historyPending ?? (
            <ul className="flex flex-wrap gap-2">
              {reports.map((r) => (
                <li key={r.id}>
                  <a
                    href={`/api/monitor/targets/${t.id}/reports/${r.month}.pdf`}
                    download
                    className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
                  >
                    <FontAwesomeIcon icon={faFilePdf} className="h-3.5 w-3.5 text-[var(--danger)]" aria-hidden />
                    {monthLabel(r.month)}
                    {r.id === "current" ? " (en cours)" : ""}
                    <span className="sr-only">(PDF)</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Tile>
      </div>

      <ConfirmDialog
        open={accept !== null}
        title={accept === "dns" ? "Accepter le DNS actuel ?" : "Accepter l'accueil actuel ?"}
        message={
          accept === "dns"
            ? `Les enregistrements DNS actuels de ${t.hostname} deviennent la référence : un écart ne sera plus signalé tant qu'ils ne changent pas.`
            : `La page d'accueil actuelle de ${t.hostname} devient la référence : seul un nouveau changement sera signalé.`
        }
        confirmLabel="Accepter comme référence"
        busy={busy === "accept"}
        onConfirm={async () => {
          const kind = accept;
          if (!kind) return;
          const done = await run(
            "accept",
            () => api<MonitorTargetEntry>(`/api/monitor/targets/${t.id}/${kind}/accept`, { method: "POST" }),
            "Nouvelle référence enregistrée",
          );
          if (done) setAccept(null);
        }}
        onClose={() => setAccept(null)}
      />
    </>
  );
}

const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
function monthLabel(month: string): string {
  const label = monthFmt.format(new Date(`${month}-15T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
