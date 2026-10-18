import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { HubCachePurgeInput, HubCachePurgeResult, StorageUsage } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, plural } from "@/lib/format";
import { storageStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Check } from "@/components/ui/Check";
import { Modal } from "@/components/ui/Modal";
import { Tile } from "@/components/ui/Tile";
import { TileDetails } from "@/components/settings/ControlsSection";

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

/** Tuile Stockage : place utilisée, libération de place dans une modale, détail par site dans un dépliant. */
export function StorageSection() {
  const usage = useResource<StorageUsage>("/api/storage");
  const [choice, setChoice] = useState<Record<Choice, boolean>>({ uploads: false, temp: true, thumbnails: false, orphans: true });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HubCachePurgeResult | null>(null);
  const picked = CHOICES.filter((c) => choice[c.id]);
  const total = usage.data?.total;
  const sites = [...(usage.data?.sites ?? [])].sort((a, b) => b.totalBytes - a.totalBytes);

  async function purge() {
    setBusy(true);
    try {
      // Confirmation donnée dans la modale : exigée par le serveur pour les envois et les vignettes.
      const body: HubCachePurgeInput = { ...Object.fromEntries(CHOICES.map((c) => [c.id, choice[c.id]])), confirm: true };
      const res = await api<HubCachePurgeResult>("/api/storage/purge", { method: "POST", json: body });
      setResult(res);
      setOpen(false);
      toast.success(`${formatBytes(res.freedBytes)} libérés`);
      void usage.reload();
    } catch (err) {
      toast.error(errorMessage(err, "La place n'a pas pu être libérée."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tile id="stockage" className="scroll-mt-4" title="Stockage" level={2} status={storageStatus({ data: usage.data, error: usage.error })}>
      {usage.loading && !usage.data ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Mesure de la place utilisée…
        </p>
      ) : usage.error && !usage.data ? (
        <Button variant="ghost" className="self-start" onClick={() => void usage.reload()}>
          Réessayer
        </Button>
      ) : total ? (
        <>
          <p className="tile-value">
            {formatBytes(total.totalBytes)} <span className="text-sm font-normal text-[var(--muted)]">sur le serveur du hub</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
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
              <dt className="text-xs text-[var(--muted)]">Temporaires et orphelins</dt>
              <dd>{formatBytes(total.tempBytes + total.orphanBytes)}</dd>
            </div>
          </dl>
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
          <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
            Libérer de la place
          </Button>
          <TileDetails summary={`Place par site (${sites.length})`}>
            <p className="text-xs text-[var(--muted)]">Un même fichier présent dans plusieurs versions n'est stocké qu'une fois.</p>
            {sites.length === 0 ? (
              <p>Aucun site pour l'instant.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {sites.map((s) => (
                  <li key={s.siteId} className="flex flex-wrap items-center justify-between gap-x-3 py-1">
                    <Link to={`/sites/${s.siteId}`} className="link inline-flex min-h-11 items-center break-all font-mono">
                      {s.slug}
                    </Link>
                    <span className="text-right text-xs text-[var(--muted)]">
                      <span className="block text-sm font-semibold text-[var(--text)]">{formatBytes(s.totalBytes)}</span>
                      travail {formatBytes(s.workingBytes)}, versions {formatBytes(s.versionsBytes)}, vignette {formatBytes(s.thumbnailBytes)}
                      {s.uploadsBytes ? `, envois ${formatBytes(s.uploadsBytes)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TileDetails>
        </>
      ) : null}

      <Modal open={open} onClose={() => setOpen(false)} title="Libérer de la place" description="Les fichiers des sites et leurs versions ne sont jamais touchés ici.">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void purge();
          }}
        >
          <fieldset>
            <legend className="sr-only">Éléments à supprimer</legend>
            {CHOICES.map((c) => (
              <Check key={c.id} checked={choice[c.id]} onChange={(v) => setChoice((prev) => ({ ...prev, [c.id]: v }))} label={c.label} hint={c.hint} />
            ))}
          </fieldset>
          {choice.uploads ? <p className="text-sm text-[var(--warning)]">Un envoi en cours sur un autre appareil devra être relancé.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={choice.uploads ? "danger" : "primary"} disabled={busy || picked.length === 0}>
              {busy ? "Libération…" : "Libérer la place"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Annuler
            </Button>
          </div>
        </form>
      </Modal>
    </Tile>
  );
}
