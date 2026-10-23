import { useId, useState } from "react";
import { toast } from "sonner";
import type { SiteDetail } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Indexation par les moteurs (cinquième série, 22/10/2026), désactivée par défaut. Le réglage vit dans le Worker du
 * déploiement : la version en ligne est republiée aussitôt pour l'appliquer.
 */
export function IndexingCard({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const ids = useId();
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const running = site.operation?.status === "RUNNING";
  const locked = site.state === "DELETING" || site.state === "CREATING" || running;
  const canRepublish = site.currentVersion !== null && site.state === "ONLINE";

  async function apply(next: boolean) {
    setBusy(true);
    try {
      let updated = await api<SiteDetail>(`/api/sites/${site.id}`, { method: "PATCH", json: { allowIndexing: next } });
      onSite(updated);
      if (canRepublish && site.currentVersion) {
        try {
          updated = await api<SiteDetail>(`/api/sites/${site.id}/versions/${site.currentVersion.id}/publish`, { method: "POST" });
          onSite(updated);
          toast.success(next ? "Indexation autorisée : republication lancée" : "Indexation interdite : republication lancée");
        } catch (err) {
          toast.warning(`Réglage enregistré, mais la republication a échoué (${errorMessage(err)}). Il s'appliquera à la prochaine publication.`);
        }
      } else {
        toast.success(next ? "Indexation autorisée : appliquée à la prochaine publication" : "Indexation interdite : appliquée à la prochaine publication");
      }
      setPending(null);
    } catch (err) {
      toast.error(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Indexation par les moteurs</h2>
      <div className="mt-3">
        <Switch
          checked={site.allowIndexing}
          onChange={(next) => setPending(next)}
          label="Autoriser l'indexation par les moteurs"
          stateLabels={{ on: "Autorisée", off: "Interdite (par défaut)" }}
          disabled={locked || busy}
          describedBy={`${ids}-effect`}
        />
      </div>
      <p id={`${ids}-effect`} className="mt-2 max-w-[65ch] text-sm text-[var(--muted)]">
        {site.allowIndexing
          ? `Google et les autres moteurs peuvent référencer ${site.hostname} : plus d'en-tête noindex, et le robots.txt du site est servi (sinon un robots.txt qui autorise tout, avec le plan du site s'il existe).`
          : `Version de travail : ${site.hostname} demande aux moteurs de ne pas l'indexer (en-tête noindex, robots.txt qui interdit tout). À activer seulement si ce sous-domaine doit apparaître dans les résultats de recherche.`}{" "}
        Les adresses pages.dev restent redirigées et jamais indexées.
      </p>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? "Autoriser l'indexation ?" : "Interdire l'indexation ?"}
        message={
          <div className="space-y-2">
            <p>
              {pending
                ? `${site.hostname} pourra apparaître dans Google et les autres moteurs de recherche.`
                : `${site.hostname} demandera de nouveau aux moteurs de ne pas l'indexer. Les pages déjà référencées disparaissent des résultats au fil des passages des robots.`}
            </p>
            <p>
              {canRepublish
                ? `La version en ligne (version ${site.currentVersion?.number}) est republiée pour appliquer le réglage.`
                : "Le réglage s'appliquera à la prochaine publication."}
            </p>
          </div>
        }
        confirmLabel={pending ? "Autoriser" : "Interdire"}
        busy={busy}
        onConfirm={() => pending !== null && void apply(pending)}
        onClose={() => setPending(null)}
      />
    </Card>
  );
}
