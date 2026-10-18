import { useId, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBroom } from "@fortawesome/free-solid-svg-icons";
import type { SiteDetail, SiteFilesPurgeResult } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, plural } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Check } from "@/components/ui/Check";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input } from "@/components/ui/Field";

const list = (numbers: number[]) => numbers.map((n) => `version ${n}`).join(", ");

/**
 * Vider les fichiers de travail (zone sensible). La version en ligne n'est jamais touchée ; avec les
 * anciennes versions, action la plus grave : le sous-domaine est demandé, comme pour la suppression.
 */
export function PurgeFilesCard({ site, onPurged }: { site: SiteDetail; onPurged: () => void }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [withVersions, setWithVersions] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SiteFilesPurgeResult | null>(null);
  const locked = site.state === "DELETING" || site.operation?.status === "RUNNING";
  const slugOk = !withVersions || confirmText.trim() === site.slug;

  function close() {
    setOpen(false);
    setWithVersions(false);
    setConfirmText("");
    setError(null);
  }

  async function purge() {
    if (!slugOk) {
      setError(`Saisissez exactement « ${site.slug} ».`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<SiteFilesPurgeResult>(`/api/sites/${site.id}/files/purge`, {
        method: "POST",
        json: { confirm: site.slug, versions: withVersions },
      });
      setResult(res);
      close();
      toast.success("Fichiers de travail vidés");
      onPurged();
    } catch (err) {
      const message = errorMessage(err, "L'opération n'a pas abouti.");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const v = result?.versions;
  return (
    <Card className="space-y-4 border-[var(--danger)]/40 p-4 sm:p-5">
      <div>
        <h2 id={`${ids}-title`} className="text-base font-semibold text-[var(--danger)]">
          Vider les fichiers de travail
        </h2>
        <p className="mt-1 text-sm text-[var(--text)]">
          Retire tous les fichiers de l'onglet Fichiers. Le site en ligne et l'historique des versions sont gardés : une version
          peut toujours être republiée ou restaurée.
        </p>
      </div>
      {result ? (
        <Banner level={v?.failed.length ? "warning" : "info"} role="status">
          <p>
            {plural(result.removedFiles, "fichier retiré", "fichiers retirés")}, {formatBytes(result.freedBytes)} libérés.
          </p>
          {v ? (
            <ul className="mt-1 list-disc pl-5">
              <li>{v.purged.length ? `Anciennes versions supprimées : ${list(v.purged)}.` : "Aucune ancienne version à supprimer."}</li>
              {v.kept.length ? <li>Gardées : {list(v.kept)}.</li> : null}
              {v.failed.map((f) => (
                <li key={f.number}>
                  Version {f.number} non supprimée : {f.error} Relancez plus tard pour la retirer.
                </li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      <Button variant="danger" onClick={() => setOpen(true)} disabled={locked}>
        <FontAwesomeIcon icon={faBroom} className="h-3.5 w-3.5" aria-hidden />
        Vider les fichiers de travail
      </Button>

      <ConfirmDialog
        open={open}
        title="Vider les fichiers de travail ?"
        danger
        busy={busy}
        confirmDisabled={!slugOk}
        confirmLabel={withVersions ? "Vider et supprimer les anciennes versions" : "Vider les fichiers de travail"}
        onConfirm={() => void purge()}
        onClose={close}
        message={
          <>
            <p>
              Tous les fichiers de travail de <strong className="font-mono">{site.hostname}</strong> seront retirés. Le site en ligne ne
              change pas.
            </p>
            <p className="mt-2 text-[var(--muted)]">Le fichier .htaccess part aussi : le hub ne le recrée pas tout seul (onglet Serveur).</p>
          </>
        }
      >
        <div className="mt-3 space-y-3">
          <Check
            checked={withVersions}
            onChange={(c) => {
              setWithVersions(c);
              setError(null);
            }}
            label="Supprimer aussi les anciennes versions"
            hint="La version en ligne est toujours gardée. Les autres ne pourront plus être republiées."
          />
          {withVersions ? (
            <Field label={`Pour confirmer, saisissez le sous-domaine : ${site.slug}`} error={error ?? undefined}>
              <Input
                value={confirmText}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                onChange={(e) => {
                  setConfirmText(e.target.value);
                  setError(null);
                }}
              />
            </Field>
          ) : error ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </Card>
  );
}
