import { useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCube, faImage, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareDetail } from "@hub/contract";
import { api, errorMessage, upload } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SiteThumb } from "@/components/sites/SiteThumb";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Vignette du catalogue d'un logiciel : image envoyée seulement (la capture du hub ne joint aucun réseau extérieur). */
export function SoftwareThumbnailTab({ detail, onDetail }: { detail: SoftwareDetail; onDetail: (d: SoftwareDetail) => void }) {
  const slug = detail.software.slug;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError(`« ${file.name} » n'est pas une image PNG, JPEG ou WebP.`);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`« ${file.name} » dépasse 10 Mo.`);
      return;
    }
    setBusy("upload");
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      onDetail(await upload<SoftwareDetail>(`/api/logiciels/${slug}/vignette`, form));
      toast.success("Vignette remplacée");
    } catch (err) {
      const message = errorMessage(err, "Envoi de l'image impossible.");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      onDetail(await api<SoftwareDetail>(`/api/logiciels/${slug}/vignette`, { method: "DELETE" }));
      toast.success("Vignette retirée");
    } catch (err) {
      toast.error(errorMessage(err, "Retrait impossible."));
    } finally {
      setBusy(null);
    }
  }

  const has = detail.software.thumbnailUrl !== null;
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Vignette du catalogue</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">{has ? "Image envoyée à la main." : "Pas encore de vignette : envoyez une capture du logiciel."}</p>
      <div className="mt-4 max-w-xl overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        <SiteThumb src={detail.software.thumbnailUrl} icon={faCube} eager />
      </div>
      <div className="mt-4 flex flex-wrap gap-2 [&>*]:flex-[1_1_12rem] sm:[&>*]:flex-none">
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy !== null}>
          <FontAwesomeIcon icon={faImage} className="h-3.5 w-3.5" aria-hidden />
          {busy === "upload" ? "Envoi…" : has ? "Remplacer l'image" : "Envoyer une image"}
        </Button>
        {has ? (
          <Button variant="ghost" onClick={() => void remove()} disabled={busy !== null}>
            <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
            {busy === "remove" ? "Retrait…" : "Retirer l'image"}
          </Button>
        ) : null}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            void send(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">Image PNG, JPEG ou WebP, 10 Mo au plus, recadrée au format 16:10.</p>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
