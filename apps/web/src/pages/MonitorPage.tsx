import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faChevronRight,
  faCircleCheck,
  faCircleInfo,
  faCloud,
  faHeartPulse,
  faPlus,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import type { CloudflareZoneSuggestion, MonitorOverview, MonitorTargetEntry } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatAgo, formatDateTime, plural } from "@/lib/format";
import { byGravity, EXPIRY_WARN_DAYS, formatDuration, formatSince, formatUptime, soonestExpiry, VERDICT } from "@/lib/monitor";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Explain } from "@/components/ui/InfoTip";
import { Tile } from "@/components/ui/Tile";
import { StatStrip } from "@/components/ui/StatStrip";
import { AddDomainDialog } from "@/components/monitor/AddDomainDialog";
import type { GlossaryKey } from "@/lib/glossary";

const OK = { icon: faCircleCheck, ink: "text-[var(--success)]" };
const WARN = { icon: faTriangleExclamation, ink: "text-[var(--warning)]" };
const INFO = { icon: faCircleInfo, ink: "text-[var(--info)]" };

/** Incidents montrés dans la tuile ; les autres restent sur la fiche de chaque adresse. */
const INCIDENTS_SHOWN = 5;

function HealthRow({ label, icon, ink, tip, children }: { label: string; icon: IconDefinition; ink: string; tip?: GlossaryKey; children: ReactNode }) {
  return (
    <div className="py-1.5 first:pt-0 last:pb-0">
      <dt className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
        <FontAwesomeIcon icon={icon} className={`h-3.5 w-3.5 shrink-0 ${ink}`} aria-hidden />
        {label}
        {tip ? <Explain k={tip} /> : null}
      </dt>
      <dd className="pl-5.5 text-sm text-[var(--muted)]">{children}</dd>
    </div>
  );
}

export function MonitorPage() {
  useTitle("Surveillance");
  const overview = useResource<MonitorOverview>("/api/monitor");
  const zones = useResource<{ available: boolean; zones: CloudflareZoneSuggestion[] }>("/api/monitor/zones");
  const [addOpen, setAddOpen] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);

  function upsert(t: MonitorTargetEntry) {
    overview.setData((prev) =>
      prev ? { ...prev, targets: prev.targets.some((x) => x.id === t.id) ? prev.targets.map((x) => (x.id === t.id ? t : x)) : [...prev.targets, t] } : prev,
    );
    void overview.reload();
  }

  async function watchZone(name: string) {
    setWatching(name);
    try {
      const t = await api<MonitorTargetEntry>(`/api/monitor/zones/${encodeURIComponent(name)}/watch`, { method: "POST" });
      upsert(t);
      zones.setData((prev) => (prev ? { ...prev, zones: prev.zones.map((z) => (z.name === name ? { ...z, alreadyWatched: true } : z)) } : prev));
      toast.success(`${name} est surveillé`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWatching(null);
    }
  }

  const addButton = (
    <Button onClick={() => setAddOpen(true)}>
      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
      Ajouter un domaine
    </Button>
  );

  const o = overview.data;
  const targets = [...(o?.targets ?? [])].sort(byGravity);

  return (
    <>
      <PageHeader
        title="Surveillance"
        subtitle={<span className="max-sm:sr-only">Disponibilité des sites, vue par le hub et par Cloudflare, avec alertes sur le téléphone.</span>}
        actions={addButton}
      />

      {overview.loading ? (
        <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
          Lecture de la surveillance…
        </p>
      ) : overview.error && !o ? (
        <Card>
          <EmptyState
            title="La surveillance n'a pas pu être lue."
            hint={overview.error}
            action={<Button variant="secondary" onClick={() => void overview.reload()}>Réessayer</Button>}
          />
        </Card>
      ) : o ? (
        <div className="space-y-6">
          {o.health.push.devices === 0 ? (
            // Rappel tant qu'aucun appareil n'est abonné : sans lui, aucune alerte n'arrive.
            <Banner
              level="warning"
              action={
                <Link to="/reglages#notifications" className="link inline-flex min-h-11 items-center text-sm font-medium">
                  Activer les notifications
                </Link>
              }
            >
              Aucun appareil ne reçoit les alertes : une panne ne vous serait pas signalée. Activez les notifications sur votre téléphone,
              dans Réglages, Notifications.
            </Banner>
          ) : null}
          <div className="bento bento-wide">
            <StatStrip
              dense
              className="tile-full rounded-[var(--radius)] shadow-none"
              items={[
                { label: "Surveillés", value: o.stats.watched },
                { label: "En ligne", value: o.stats.up, tone: o.stats.up ? "success" : "default" },
                { label: "En panne", shortLabel: "Pannes", value: o.stats.down, tone: o.stats.down ? "danger" : "default" },
                { label: "Avertissements", shortLabel: "Alertes", value: o.stats.warnings, tone: o.stats.warnings ? "warning" : "default" },
                { label: "Incidents ouverts", shortLabel: "Incidents", value: o.stats.openIncidents, tone: o.stats.openIncidents ? "danger" : "default" },
              ]}
            />

            <Tile title="Points de contrôle" level={2} span={2}>
              <dl>
                <HealthRow label="Le hub" tip="hub" {...(o.health.hubChecksRunning ? OK : WARN)}>
                  {o.health.hubChecksRunning ? "Contrôles en cours toutes les 5 minutes." : "Contrôles arrêtés : redémarrez le hub."}
                </HealthRow>
                <HealthRow label="Cloudflare (Worker de veille)" tip="worker" {...(!o.health.edge.configured ? INFO : o.health.edge.error ? WARN : OK)}>
                  {!o.health.edge.configured
                    ? "Non configuré : seules les observations du hub comptent, et aucune alerte ne part si la box est coupée."
                    : o.health.edge.error
                      ? `Erreur : ${o.health.edge.error}`
                      : `Dernier passage ${o.health.edge.lastSeenAt ? formatAgo(o.health.edge.lastSeenAt) : "inconnu"}${o.health.edge.lastSyncAt ? `, configuration envoyée ${formatAgo(o.health.edge.lastSyncAt)}` : ""}.`}
                </HealthRow>
              </dl>
              <details className="code-details mt-auto">
                <summary className="code-summary">
                  <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
                  Marche à suivre
                </summary>
                <ol className="list-decimal space-y-2 pb-2 pl-5 text-sm text-[var(--text)]">
                  <li>
                    Sur le serveur du hub : <code className="font-mono">hubctl push-keys</code>, puis ici, Réglages, Notifications, « Activer sur
                    cet appareil » et la notification de test.
                  </li>
                  <li>
                    Créer chez Cloudflare un jeton « Workers Scripts : modifier » et « D1 : modifier », lancer{" "}
                    <code className="font-mono">hubctl veille deploy</code> et le coller (il n'est pas gardé).
                  </li>
                  <li>
                    Facultatif : un jeton « Zone : lecture » sur toutes les zones, posé par <code className="font-mono">hubctl secrets veille</code>,
                    pour proposer les domaines Cloudflare.
                  </li>
                  <li>Ajouter à la main les domaines hébergés ailleurs (Hostinger).</li>
                </ol>
              </details>
            </Tile>

            <Tile title="Notifications" level={2} tip="push" tone={o.health.push.configured && o.health.push.devices > 0 ? undefined : "warn"}>
              <p className="flex items-start gap-2 text-sm text-[var(--muted)]">
                <FontAwesomeIcon
                  icon={(o.health.push.configured && o.health.push.devices > 0 ? OK : WARN).icon}
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${(o.health.push.configured && o.health.push.devices > 0 ? OK : WARN).ink}`}
                  aria-hidden
                />
                <span>
                  {!o.health.push.configured
                    ? "Non configurées : les clés de notification manquent sur le hub."
                    : o.health.push.devices > 0
                      ? `${plural(o.health.push.devices, "appareil reçoit", "appareils reçoivent")} les alertes.`
                      : "Aucun appareil : activez les notifications sur votre téléphone."}
                </span>
              </p>
              {o.health.push.configured ? (
                <Link to="/reglages#notifications" className="link inline-flex min-h-11 items-center self-start text-sm font-medium">
                  Réglages des notifications
                </Link>
              ) : null}
            </Tile>

            <Tile title="Incidents récents" level={2} tip="incident">
              {o.recentIncidents.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Aucun incident récent.</p>
              ) : (
                <>
                  <ul className="divide-y divide-[var(--border)]">
                    {o.recentIncidents.slice(0, INCIDENTS_SHOWN).map((i) => (
                      <li key={i.id} className="py-1.5 text-sm first:pt-0 last:pb-0">
                        <Link to={`/surveillance/${i.targetId}`} className="link inline-flex min-h-6 items-center font-medium break-words">
                          {i.targetLabel}
                        </Link>
                        <span className="block text-xs text-[var(--muted)]">
                          {i.endedAt ? `${formatDateTime(i.startedAt)}, durée ${formatDuration(i.durationMs ?? 0)}` : `En cours depuis ${formatSince(i.startedAt)}`}
                          {i.cause ? `, ${i.cause}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {o.recentIncidents.length > INCIDENTS_SHOWN ? (
                    <p className="text-xs text-[var(--muted)]">
                      Et {o.recentIncidents.length - INCIDENTS_SHOWN} de plus, sur la fiche de chaque adresse.
                    </p>
                  ) : null}
                </>
              )}
            </Tile>

            <Tile title="Domaines Cloudflare proposés" level={2} tip="zones" span={2}>
              {zones.loading ? (
                <p role="status" className="text-sm text-[var(--muted)]">
                  Lecture des domaines…
                </p>
              ) : zones.error && !zones.data ? (
                <Banner level="error" action={<Button variant="ghost" onClick={() => void zones.reload()}>Réessayer</Button>}>
                  {zones.error}
                </Banner>
              ) : !zones.data?.available ? (
                <p className="flex items-start gap-2 text-sm text-[var(--muted)]">
                  <FontAwesomeIcon icon={faCloud} className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Le jeton de lecture des domaines Cloudflare n'est pas posé : rien n'est proposé. Voir « Marche à suivre », étape 3.
                </p>
              ) : zones.data.zones.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Aucun domaine sur le compte Cloudflare.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {zones.data.zones.map((z) => (
                    <li key={z.name} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="break-all font-mono text-sm text-[var(--text)]">{z.name}</span>
                      {z.alreadyWatched ? (
                        <span className="inline-flex items-center gap-1.5 text-sm text-[var(--muted)]">
                          <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5 text-[var(--success)]" aria-hidden />
                          Déjà surveillé
                        </span>
                      ) : (
                        <Button variant="secondary" onClick={() => void watchZone(z.name)} disabled={watching !== null}>
                          {watching === z.name ? "Ajout…" : `Surveiller ${z.name}`}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Tile>
          </div>

          <section aria-labelledby="adresses-titre" className="space-y-2">
            <h2 id="adresses-titre" className="text-lg font-semibold">
              Adresses surveillées
            </h2>
            {targets.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<FontAwesomeIcon icon={faHeartPulse} className="h-5 w-5" aria-hidden />}
                  title="Aucune adresse surveillée pour l'instant."
                  hint="Les sites du hub s'ajoutent d'eux-mêmes une fois en ligne. Ajoutez ici les domaines hébergés ailleurs."
                  action={addButton}
                />
              </Card>
            ) : (
              <ul className="monitor-list ui-card divide-y divide-[var(--border)] overflow-hidden p-0">
                {targets.map((t) => (
                  <TargetRow key={t.id} target={t} />
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      <AddDomainDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={upsert} />
    </>
  );
}

function TargetRow({ target: t }: { target: MonitorTargetEntry }) {
  const look = VERDICT[t.verdict];
  const days = soonestExpiry(t);
  const label = !t.enabled ? "Non surveillé" : t.verdict === "down" && t.openIncident ? `Panne depuis ${formatSince(t.openIncident.startedAt)}` : look.label;
  return (
    <li className={`monitor-row ${t.enabled && t.verdict === "down" ? "bg-[var(--danger-soft)]" : ""}`}>
      <div className="min-w-0">
        <Link to={t.siteId ? `/sites/${t.siteId}?tab=surveillance` : `/surveillance/${t.id}`} className="link font-medium break-words">
          {t.label}
        </Link>
        <span className="block break-all font-mono text-xs text-[var(--muted)]">{t.hostname}</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {t.enabled ? (
          <Badge tone={look.tone}>
            <FontAwesomeIcon icon={look.icon} className="h-3 w-3" aria-hidden />
            {label}
          </Badge>
        ) : (
          <span className="text-xs text-[var(--muted)]">{label}</span>
        )}
        {t.enabled && days != null && days <= EXPIRY_WARN_DAYS ? (
          <Badge tone="amber">
            <FontAwesomeIcon icon={faTriangleExclamation} className="h-3 w-3" aria-hidden />
            Échéance dans {days} j
          </Badge>
        ) : null}
      </div>
      {t.enabled ? (
        <p className="monitor-row-meta text-xs text-[var(--muted)]">
          {[
            formatUptime(t.uptime30d) ? `${formatUptime(t.uptime30d)} sur 30 jours` : null,
            t.lastHub || t.lastEdge
              ? `contrôlé ${formatAgo([t.lastHub?.at, t.lastEdge?.at].filter(Boolean).sort().pop() ?? null)}`
              : "pas encore contrôlé",
          ]
            .filter(Boolean)
            .join(", ")
            .replace(/^./, (c) => c.toUpperCase())}
        </p>
      ) : null}
    </li>
  );
}
