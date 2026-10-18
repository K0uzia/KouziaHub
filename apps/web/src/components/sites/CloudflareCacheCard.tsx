import { useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRotate } from "@fortawesome/free-solid-svg-icons";
import type { CachePurgeResult, SiteDetail } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { formatDecimal } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Failure = { kind: "permission" | "rate" | "other"; message: string };

/** Vider le cache Cloudflare de l'adresse : utile rarement, le texte dit quand. */
export function CloudflareCacheCard({ site }: { site: SiteDetail }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CachePurgeResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const locked = site.state === "DELETING" || site.operation?.status === "RUNNING";

  async function purge() {
    setBusy(true);
    setFailure(null);
    try {
      const res = await api<CachePurgeResult>(`/api/sites/${site.id}/cache/purge`, { method: "POST" });
      setResult(res);
      setOpen(false);
      if (res.complete) toast.success("Cache Cloudflare vidé");
      else toast.warning("Cache vidé en partie : relancez dans une minute");
    } catch (err) {
      const e = err as ApiError;
      const kind = e.code === "cf_permission" ? "permission" : e.code === "cf_rate_limited" ? "rate" : "other";
      setFailure({ kind, message: errorMessage(err, "Le cache n'a pas pu être vidé.") });
      setResult(null);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold">Cache Cloudflare de l'adresse</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Une nouvelle publication sert déjà les nouveaux fichiers : en temps normal, rien à faire. Utile après un changement des règles de
          cache, ou si un ancien fichier reste affiché sur <span className="font-mono">{site.hostname}</span>.
        </p>
      </div>

      {result ? (
        <Banner level={result.complete ? "info" : "warning"} role="status">
          <p>{result.message}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {result.method === "hosts"
              ? `Adresses vidées en entier : ${result.hosts.join(", ")}.`
              : `Fichiers vidés un à un : ${formatDecimal(result.urlsPurged, 0)} sur ${formatDecimal(result.urlsTotal, 0)}.`}
            {result.skippedHosts.length
              ? ` Domaine final non concerné (géré à part chez Cloudflare) : ${result.skippedHosts.join(", ")}.`
              : ""}
          </p>
        </Banner>
      ) : null}

      {failure ? (
        <Banner level={failure.kind === "rate" ? "warning" : "error"} role="alert">
          {failure.kind === "permission" ? (
            <>
              <p>Le jeton Cloudflare du hub n'a pas le droit de vider le cache.</p>
              <p className="mt-1">
                Ajoutez le droit « Zone, Cache Purge, Purge » (zone kouzia.com) au jeton, puis enregistrez-le sur le serveur avec{" "}
                <code className="font-mono">hubctl secrets api</code>.
              </p>
            </>
          ) : failure.kind === "rate" ? (
            <p>Cloudflare limite le nombre de vidages : réessayez dans une minute.</p>
          ) : (
            <p>{failure.message}</p>
          )}
        </Banner>
      ) : null}

      <Button variant="secondary" onClick={() => setOpen(true)} disabled={locked}>
        <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" aria-hidden />
        Vider le cache Cloudflare
      </Button>

      <ConfirmDialog
        open={open}
        title="Vider le cache Cloudflare ?"
        message={
          <>
            <p>
              Cloudflare oubliera les copies gardées de <strong className="font-mono">{site.hostname}</strong> et les relira au prochain
              passage d'un visiteur.
            </p>
            <p className="mt-2 text-[var(--muted)]">Le site reste en ligne ; les premières pages peuvent être un peu plus lentes.</p>
          </>
        }
        confirmLabel="Vider le cache"
        busy={busy}
        onConfirm={() => void purge()}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}
