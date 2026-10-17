import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faFilePdf, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import type { MonitorTargetDetail, MonitorTargetEntry } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatAgo, formatDate, formatDateTime, formatDecimal } from "@/lib/format";
import {
  basisLabel,
  EXPIRY_WARN_DAYS,
  formatDuration,
  formatMs,
  formatSince,
  formatUptime,
  VERDICT,
} from "@/lib/monitor";
import { useResource } from "@/lib/useResource";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Banner } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { UptimeBars } from "@/components/monitor/UptimeBars";

const SOURCE: Record<MonitorTargetEntry["source"], string> = {
  site: "Site du hub",
  cloudflare: "Domaine Cloudflare",
  manual: "Ajouté à la main",
};

type LastCheck = MonitorTargetEntry["lastHub"];

function checkText(c: LastCheck): string {
  if (!c) return "Pas encore de contrôle.";
  const when = formatAgo(c.at);
  if (c.ok) return `Réussi ${when}${c.status ? `, réponse ${c.status}` : ""}, ${formatMs(c.ms)}.`;
  return `Échec ${when}${c.reason ? ` : ${c.reason}` : c.status ? ` : réponse ${c.status}` : ""}.`;
}

function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd
        className={`mt-0.5 break-words text-sm ${tone === "bad" ? "text-[var(--danger)]" : tone === "warn" ? "text-[var(--warning)]" : "text-[var(--text)]"}`}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Une cible surveillée : interrupteur, verdict et point de vue, derniers contrôles, disponibilité, échéances,
 * DNS et contenu (avec « Accepter comme nouvelle référence »), vitesse, historique, incidents, rapports.
 */
export function TargetPanel({
  target,
  onChange,
  headingLevel = 2,
  showSiteLink = false,
}: {
  target: MonitorTargetEntry;
  onChange: (t: MonitorTargetEntry) => void;
  headingLevel?: 2 | 3;
  /** Page Surveillance : lien vers la fiche du site lié. */
  showSiteLink?: boolean;
}) {
  const ids = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const Sub = headingLevel === 2 ? "h3" : "h4";
  const detail = useResource<MonitorTargetDetail>(`/api/monitor/targets/${target.id}?days=30`, null, { keepData: true });
  const reloadDetail = detail.reload;
  const [busy, setBusy] = useState<"switch" | "check" | "accept" | null>(null);
  const [accept, setAccept] = useState<"dns" | "content" | null>(null);
  const t = target;
  const look = VERDICT[t.verdict];

  // Cible changée (contrôle, interrupteur, référence) : historique et incidents relus.
  const signature = `${t.lastHub?.at}|${t.lastEdge?.at}|${t.enabled}|${t.openIncident?.id}|${t.dns?.status}|${t.content?.status}`;
  useEffect(() => {
    void reloadDetail();
  }, [signature, reloadDetail]);

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

  const certTone = t.certificate && (!t.certificate.ok ? "bad" : t.certificate.daysLeft <= EXPIRY_WARN_DAYS ? "warn" : undefined);
  const domainTone = t.domainExpiry?.daysLeft != null && t.domainExpiry.daysLeft <= EXPIRY_WARN_DAYS ? "warn" : undefined;
  const reports = detail.data?.reports ?? [];
  const incidents = detail.data?.incidents ?? [];

  return (
    <Card className={`space-y-5 p-4 sm:p-5 ${t.enabled && t.verdict === "down" ? "border-[var(--danger)]" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading className="break-words text-base font-semibold">{t.label}</Heading>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-[var(--muted)]">
            <a href={t.url} target="_blank" rel="noopener noreferrer" className="link inline-flex min-h-6 items-center gap-1.5 break-all font-mono">
              {t.hostname}
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3 shrink-0" aria-hidden />
              <span className="sr-only">(nouvel onglet)</span>
            </a>
            <span>{SOURCE[t.source]}</span>
            {t.clientName ? <span>{t.clientName}</span> : null}
            {showSiteLink && t.siteId ? (
              <Link to={`/sites/${t.siteId}?tab=surveillance`} className="link">
                Fiche du site
              </Link>
            ) : null}
          </p>
        </div>
        <div className="w-full sm:w-56">
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
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={look.tone}>
                <FontAwesomeIcon icon={look.icon} className="h-3 w-3" aria-hidden />
                {t.verdict === "down" && t.openIncident ? `Panne depuis ${formatSince(t.openIncident.startedAt)}` : look.label}
              </Badge>
              <span className="text-sm text-[var(--muted)]">{basisLabel(t.basis)}</span>
            </p>
            {t.verdict === "local_only" ? (
              <p className="text-sm text-[var(--muted)]">Le hub n'arrive pas à joindre le site, Cloudflare oui : problème de la box ou du DNS local, pas d'alerte.</p>
            ) : t.verdict === "edge_only" ? (
              <p className="text-sm text-[var(--muted)]">Le hub joint le site, Cloudflare non : à surveiller, pas d'alerte.</p>
            ) : null}
          </div>

          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Dernier contrôle du hub" tone={t.lastHub && !t.lastHub.ok ? "bad" : undefined}>
              {checkText(t.lastHub)}
            </Fact>
            <Fact label="Dernier contrôle de Cloudflare" tone={t.lastEdge && !t.lastEdge.ok ? "bad" : undefined}>
              {checkText(t.lastEdge)}
            </Fact>
            <Fact label="Disponibilité">
              24 h : {formatUptime(t.uptime24h) ?? "pas assez de données"} ; 30 jours : {formatUptime(t.uptime30d) ?? "pas assez de données"}
            </Fact>
            <Fact label="Certificat" tone={certTone || undefined}>
              {!t.certificate
                ? "Pas encore contrôlé."
                : !t.certificate.ok
                  ? `Invalide${t.certificate.error ? ` : ${t.certificate.error}` : ""}.`
                  : `Expire le ${formatDate(t.certificate.validTo)}, dans ${t.certificate.daysLeft} jours${t.certificate.issuer ? ` (${t.certificate.issuer})` : ""}.`}
            </Fact>
            <Fact label="Domaine" tone={domainTone}>
              {!t.domainExpiry
                ? "Pas encore contrôlé."
                : t.domainExpiry.expiresAt
                  ? `Expire le ${formatDate(t.domainExpiry.expiresAt)}${t.domainExpiry.daysLeft != null ? `, dans ${t.domainExpiry.daysLeft} jours` : ""}${t.domainExpiry.registrar ? ` (${t.domainExpiry.registrar})` : ""}.`
                  : "Échéance inconnue (le registre ne la publie pas)."}
            </Fact>
            <Fact label="Vitesse (téléphone)">
              {t.speed
                ? `Premier octet ${formatMs(t.speed.ttfbMs)}, affichage principal ${formatMs(t.speed.lcpMs)}${t.speed.cls != null ? `, stabilité ${formatDecimal(t.speed.cls, 2)}` : ""}${t.speed.requests != null ? `, ${t.speed.requests} requêtes` : ""}. Mesurée ${formatAgo(t.speed.measuredAt)}.`
                : "Pas encore mesurée (une mesure par semaine)."}
            </Fact>
            <Fact label="DNS" tone={t.dns?.status === "drift" || t.dns?.status === "error" ? "warn" : undefined}>
              {!t.dns
                ? "Pas encore contrôlé."
                : t.dns.status === "ok"
                  ? "Conforme à la référence."
                  : t.dns.status === "drift"
                    ? `Différent de la référence${t.dns.detail ? ` : ${t.dns.detail}` : ""}.`
                    : t.dns.status === "no_reference"
                      ? "Pas encore de référence."
                      : `Contrôle impossible${t.dns.detail ? ` : ${t.dns.detail}` : ""}.`}
              {t.dns?.status === "drift" || t.dns?.status === "no_reference" ? (
                <span className="mt-2 block">
                  <Button variant="secondary" onClick={() => setAccept("dns")} disabled={busy !== null}>
                    Accepter comme nouvelle référence
                  </Button>
                </span>
              ) : null}
            </Fact>
            <Fact label="Contenu de l'accueil" tone={t.content?.status === "changed" || t.content?.status === "error" ? "warn" : undefined}>
              {!t.content
                ? "Pas encore contrôlé."
                : t.content.status === "ok"
                  ? "Inchangé depuis la référence."
                  : t.content.status === "changed"
                    ? "Changé sans publication par le hub."
                    : t.content.status === "no_reference"
                      ? "Pas encore de référence."
                      : "Contrôle impossible."}
              {t.content?.status === "changed" || t.content?.status === "no_reference" ? (
                <span className="mt-2 block">
                  <Button variant="secondary" onClick={() => setAccept("content")} disabled={busy !== null}>
                    Accepter comme nouvelle référence
                  </Button>
                </span>
              ) : null}
            </Fact>
          </dl>

          <Button
            variant="secondary"
            onClick={() =>
              void run("check", () => api<MonitorTargetEntry>(`/api/monitor/targets/${t.id}/check`, { method: "POST" }), "Contrôle effectué")
            }
            disabled={busy !== null}
          >
            <FontAwesomeIcon icon={faRotateRight} className="h-3.5 w-3.5" aria-hidden />
            {busy === "check" ? "Contrôle…" : "Contrôler maintenant"}
          </Button>
        </>
      ) : (
        <p className="text-sm text-[var(--muted)]">Surveillance coupée : aucun contrôle ni alerte pour cette adresse. L'historique est gardé.</p>
      )}

      <section aria-labelledby={`${ids}-hist`} className="space-y-3 border-t border-[var(--border)] pt-4">
        <Sub id={`${ids}-hist`} className="text-sm font-semibold">
          Historique
        </Sub>
        {detail.error && !detail.data ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void detail.reload()}>Réessayer</Button>}>
            {detail.error}
          </Banner>
        ) : !detail.data ? (
          <p role="status" className="text-sm text-[var(--muted)]">
            Lecture de l'historique…
          </p>
        ) : (
          <>
            <UptimeBars history={detail.data.history} />
            <div>
              <p className="text-sm font-medium text-[var(--text)]">Incidents récents</p>
              {incidents.length === 0 ? (
                <p className="mt-1 text-sm text-[var(--muted)]">Aucun incident sur la période.</p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
                  {incidents.map((i) => (
                    <li key={i.id} className="px-3 py-2 text-sm">
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
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text)]">Rapports mensuels</p>
              {reports.length === 0 ? (
                <p className="mt-1 text-sm text-[var(--muted)]">Pas encore de rapport : le premier est créé le 1er du mois.</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {reports.map((r) => (
                    <li key={r.id}>
                      <a
                        href={`/api/monitor/targets/${t.id}/reports/${r.month}.pdf`}
                        download
                        className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
                      >
                        <FontAwesomeIcon icon={faFilePdf} className="h-3.5 w-3.5 text-[var(--danger)]" aria-hidden />
                        {monthLabel(r.month)}
                        <span className="sr-only">(PDF)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

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
    </Card>
  );
}

const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
function monthLabel(month: string): string {
  const label = monthFmt.format(new Date(`${month}-15T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
