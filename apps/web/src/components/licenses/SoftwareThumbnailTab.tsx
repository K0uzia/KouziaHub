import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCube, faImage, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareDetail, SoftwareThumbnailFit } from "@hub/contract";
import { api, errorMessage, upload } from "@/lib/api";
import { softwareFrame } from "@/lib/thumbFrame";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Segmented } from "@/components/ui/Segmented";
import { SiteThumb } from "@/components/sites/SiteThumb";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const KINDS = [
  { id: "logo", label: "Logo ou icône (entier, centré)" },
  { id: "capture", label: "Capture d'écran (remplit le cadre)" },
] as const;
const BACKGROUNDS = [
  { id: "logo", label: "Fond neutre" },
  { id: "logo-couleur", label: "Couleur du logo" },
] as const;

/**
 * Vignette du catalogue d'un logiciel : image envoyée (la capture du hub ne joint aucun réseau extérieur), gardée
 * entière ; cadrage à l'affichage, logo par défaut, avec un aperçu qui suit le choix avant l'enregistrement.
 */
export function SoftwareThumbnailTab({ detail, onDetail }: { detail: SoftwareDetail; onDetail: (d: SoftwareDetail) => void }) {
  const s = detail.software;
  const slug = s.slug;
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | "fit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SoftwareThumbnailFit | null>(null);
  const fit = draft ?? s.thumbnailFit;
  const has = s.thumbnailUrl !== null;
  // Image d'avant ce réglage : déjà recadrée à l'envoi, elle doit être renvoyée pour s'afficher entière.
  const legacy = has && s.thumbnailFit === null;

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
      setDraft(null);
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
      setDraft(null);
      toast.success("Vignette retirée");
    } catch (err) {
      toast.error(errorMessage(err, "Retrait impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function saveFit() {
    if (!fit) return;
    setBusy("fit");
    try {
      onDetail(await api<SoftwareDetail>(`/api/logiciels/${slug}`, { method: "PATCH", json: { thumbnailFit: fit } }));
      setDraft(null);
      toast.success("Cadrage enregistré");
    } catch (err) {
      toast.error(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setBusy(null);
    }
  }

  const kind = fit === "capture" ? "capture" : "logo";
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Vignette du catalogue</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {has ? "Image envoyée, gardée entière : le cadrage se règle ci-dessous." : "Pas encore de vignette : envoyez le logo ou une capture du logiciel."}
      </p>
      {legacy ? (
        <Banner level="warning" className="mt-4">
          Cette image a été recadrée à l'envoi, avant le réglage du cadrage. Renvoyez l'image d'origine pour l'afficher entière.
        </Banner>
      ) : null}
      <div className="mt-4 max-w-xl overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        <SiteThumb src={s.thumbnailUrl} icon={faCube} frame={softwareFrame(s, fit)} eager />
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
      <p className="mt-2 text-xs text-[var(--muted)]">Image PNG, JPEG ou WebP, 10 Mo au plus. Un logo à fond transparent garde sa transparence.</p>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {has && !legacy ? (
        <div className="mt-5 space-y-4 border-t border-[var(--border)] pt-4">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-[var(--text)]">Type d'image</span>
            <Segmented
              options={KINDS}
              value={kind}
              onChange={(k) => setDraft(k === "capture" ? "capture" : s.thumbnailFit === "logo-couleur" ? "logo-couleur" : "logo")}
              label="Type d'image"
              stack
              disabled={busy !== null}
            />
          </div>
          {kind === "logo" ? (
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-[var(--text)]">Fond du cadre</span>
              <Segmented
                options={BACKGROUNDS}
                value={fit === "logo-couleur" ? "logo-couleur" : "logo"}
                onChange={setDraft}
                label="Fond du cadre"
                stack
                disabled={busy !== null || !s.thumbnailColor}
                describedBy={s.thumbnailColor ? undefined : `${ids}-nocolor`}
              />
              {s.thumbnailColor ? null : (
                <p id={`${ids}-nocolor`} className="text-xs text-[var(--muted)]">
                  Image entièrement transparente : pas de couleur à reprendre, fond neutre.
                </p>
              )}
            </div>
          ) : null}
          <p className="text-sm text-[var(--muted)]">L'aperçu suit le choix ; la carte du catalogue l'affiche une fois enregistré.</p>
          <Button variant="secondary" onClick={() => void saveFit()} disabled={busy !== null || fit === s.thumbnailFit}>
            {busy === "fit" ? "Enregistrement…" : "Enregistrer le cadrage"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
