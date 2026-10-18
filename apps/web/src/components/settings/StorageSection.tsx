import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { HubCachePurgeInput, HubCachePurgeResult, StorageUsage } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, plural } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Check } from "@/components/ui/Check";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Choice = "uploads" | "temp" | "thumbnails" | "orphans";

const CHOICES: Array<{ id: Choice; label: string; hint: string }> = [
  { id: "uploads", label: "Envois en cours", hint: "Morceaux d'envois pas encore terminés, même récents : un envoi en cours devra être relancé." },
  { id: "temp", label: "Fichiers temporaires", hint: "Archives et fichiers de travail du serveur restés après un envoi." },
  { id: "thumbnails", label: "Vignettes capturées", hint: "Recréées à la prochaine publication. Une image envoyée à la main est gardée." },
  { id: "orphans", label: "Fichiers orphelins", hint: "Contenus que plus aucun fichier de travail ni aucune version n'utilise." },
];

const RESULT_LABEL: Record<Choice, string> = {
  uploads: "envois en cours",
  temp: "fichiers temporaires",
  thumbnails: "vignettes",
  orphans: "fichiers orphelins",
};

/** Place utilisée sur le serveur du hub, par site et au total, et purge du cache. */
export function StorageSection() {
  const ids = useId();
  const usage = useResource<StorageUsage>("/api/storage");
  const [choice, setChoice] = useState<Record<Choice, boolean>>({ uploads: false, temp: true, thumbnails: false, orphans: true });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HubCachePurgeResult | null>(null);
  const picked = CHOICES.filter((c) => choice[c.id]);
  const total = usage.data?.total;
  const sites = [...(usage.data?.sites ?? [])].sort((a, b) => b.totalBytes - a.totalBytes);

  async function purge() {
    setBusy(true);
    try {
      // Confirmation donnée dans la boîte de dialogue : exigée par le serveur pour les envois et les vignettes.
      const body: HubCachePurgeInput = { ...Object.fromEntries(CHOICES.map((c) => [c.id, choice[c.id]])), confirm: true };
      const res = await api<HubCachePurgeResult>("/api/storage/purge", { method: "POST", json: body });
      setResult(res);
      setConfirm(false);
      toast.success(`${formatBytes(res.freedBytes)} libérés`);
      void usage.reload();
    } catch (err) {
      toast.error(errorMessage(err, "La place n'a pas pu être libérée."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="stockage" aria-labelledby={`${ids}-title`} className="scroll-mt-4 space-y-4">
      <h2 id={`${ids}-title`} className="text-lg font-semibold">
        Stockage
      </h2>
      {usage.loading && !usage.data ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Mesure de la place utilisée…
        </p>
      ) : usage.error && !usage.data ? (
        <Banner level="error" action={<Button variant="ghost" onClick={() => void usage.reload()}>Réessayer</Button>}>
          {usage.error}
        </Banner>
      ) : total ? (
        <>
          <Card className="p-4 sm:p-5">
            <p className="text-sm text-[var(--muted)]">Place utilisée sur le serveur du hub</p>
            <p className="mt-1 text-2xl font-bold tracking-tight">{formatBytes(total.totalBytes)}</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-[var(--muted)]">Fichiers des sites</dt>
                <dd>{formatBytes(total.blobsBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--muted)]">Vignettes</dt>
                <dd>{formatBytes(total.thumbnailsBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--muted)]">Envois en cours</dt>
                <dd>{formatBytes(total.uploadsBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--muted)]">Temporaires</dt>
                <dd>{formatBytes(total.tempBytes)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-[var(--muted)]">
              Dont fichiers orphelins : {formatBytes(total.orphanBytes)}. Un même fichier présent dans plusieurs versions n'est stocké
              qu'une fois.
            </p>
          </Card>

          {sites.length === 0 ? (
            <Card>
              <EmptyState title="Aucun site pour l'instant." />
            </Card>
          ) : (
            <div className="ui-card ui-table-wrap max-md:border-0 max-md:bg-transparent max-md:shadow-none">
              <table className="ui-table ui-table-stack">
                <caption className="sr-only">Place utilisée par site, du plus lourd au plus léger</caption>
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col" className="nowrap">Fichiers de travail</th>
                    <th scope="col" className="nowrap">Versions gardées</th>
                    <th scope="col" className="nowrap">Vignette</th>
                    <th scope="col" className="nowrap">Envois en cours</th>
                    <th scope="col" className="nowrap" aria-sort="descending">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.siteId}>
                      <td data-label="Site" className="wrap">
                        <Link to={`/sites/${s.siteId}`} className="link inline-flex min-h-11 items-center break-all font-mono">
                          {s.slug}
                        </Link>
                      </td>
                      <td data-label="Fichiers de travail" className="nowrap">{formatBytes(s.workingBytes)}</td>
                      <td data-label="Versions gardées" className="nowrap">{formatBytes(s.versionsBytes)}</td>
                      <td data-label="Vignette" className="nowrap">{formatBytes(s.thumbnailBytes)}</td>
                      <td data-label="Envois en cours" className="nowrap">{formatBytes(s.uploadsBytes)}</td>
                      <td data-label="Total" className="nowrap font-semibold">{formatBytes(s.totalBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Card className="space-y-3 p-4 sm:p-5">
            <div>
              <h3 className="text-base font-semibold">Libérer de la place</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">Les fichiers des sites et leurs versions ne sont jamais touchés ici.</p>
            </div>
            <fieldset>
              <legend className="sr-only">Éléments à supprimer</legend>
              {CHOICES.map((c) => (
                <Check key={c.id} checked={choice[c.id]} onChange={(v) => setChoice((prev) => ({ ...prev, [c.id]: v }))} label={c.label} hint={c.hint} />
              ))}
            </fieldset>
            {result ? (
              <Banner level="info" role="status">
                <p>{formatBytes(result.freedBytes)} libérés.</p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {CHOICES.map((c) => {
                    const r = result[c.id];
                    return r ? (
                      <li key={c.id}>
                        {RESULT_LABEL[c.id]} : {plural(r.count, "élément", "éléments")}, {formatBytes(r.bytes)}
                      </li>
                    ) : null;
                  })}
                  {result.uploadsSkipped > 0 ? (
                    <li>{plural(result.uploadsSkipped, "envoi en cours de finalisation gardé", "envois en cours de finalisation gardés")}</li>
                  ) : null}
                </ul>
              </Banner>
            ) : null}
            <Button variant="secondary" disabled={picked.length === 0} onClick={() => setConfirm(true)}>
              Libérer de la place
            </Button>
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title="Libérer de la place ?"
        message={
          <>
            <p>Seront supprimés :</p>
            <ul className="mt-1 list-disc pl-5">
              {picked.map((c) => (
                <li key={c.id}>{c.label.toLowerCase()}</li>
              ))}
            </ul>
            {choice.uploads ? <p className="mt-2 text-[var(--warning)]">Un envoi en cours sur un autre appareil devra être relancé.</p> : null}
          </>
        }
        confirmLabel="Libérer la place"
        danger={choice.uploads}
        busy={busy}
        onConfirm={() => void purge()}
        onClose={() => setConfirm(false)}
      />
    </section>
  );
}
