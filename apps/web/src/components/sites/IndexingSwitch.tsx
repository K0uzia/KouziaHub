import { useId, useState } from "react";
import { toast } from "sonner";
import type { SiteDetail } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Indexation par les moteurs (cinquième série, 22/10/2026), désactivée par défaut, sous l'interrupteur de mise en
 * ligne du panneau de synthèse. Le réglage vit dans le Worker du déploiement : la version en ligne est republiée
 * aussitôt pour l'appliquer.
 */
export function IndexingSwitch({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const noteId = useId();
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
    <div className="mt-4 border-t border-[var(--border)] pt-3">
      <Switch
        checked={site.allowIndexing}
        onChange={(next) => setPending(next)}
        label="Indexation par les moteurs"
        stateLabels={{ on: "Autorisée", off: "Interdite" }}
        disabled={locked || busy}
        describedBy={noteId}
      />
      <p id={noteId} className="mt-1 text-xs text-[var(--muted)]">
        {site.allowIndexing
          ? "Google et les autres moteurs peuvent référencer le site : plus de noindex, le robots.txt du site est servi."
          : "Version de travail, non indexée (noindex). À autoriser seulement si ce sous-domaine doit apparaître dans les recherches."}{" "}
        Les adresses pages.dev ne sont jamais indexées.
      </p>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? "Autoriser l'indexation ?" : "Interdire l'indexation ?"}
        message={
          <div className="space-y-2">
            <p>
              {pending
                ? `${site.hostname} pourra apparaître dans Google et les autres moteurs de recherche : plus d'en-tête noindex, et le robots.txt du site est servi (sinon un robots.txt qui autorise tout, avec le plan du site s'il existe).`
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
    </div>
  );
}
