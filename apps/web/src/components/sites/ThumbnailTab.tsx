import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCamera, faImage } from "@fortawesome/free-solid-svg-icons";
import type { SiteDetail, ThumbnailFocus } from "@hub/contract";
import { api, errorMessage, upload } from "@/lib/api";
import { useSystem } from "@/lib/system";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SiteThumb } from "@/components/sites/SiteThumb";
import { FocusPicker } from "@/components/sites/FocusPicker";
import { siteFrame } from "@/lib/thumbFrame";

/** La capture tourne en arrière-plan : la fiche est relue un moment, jusqu'à la nouvelle vignette. */
const CAPTURE_WATCH_MS = 3000;
const CAPTURE_WATCH_MAX = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function ThumbnailTab({
  site,
  onSite,
  reloadSite,
}: {
  site: SiteDetail;
  onSite: (s: SiteDetail) => void;
  reloadSite: () => Promise<void>;
}) {
  const ids = useId();
  const system = useSystem();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"capture" | "upload" | "focus" | null>(null);
  // Point d'intérêt en cours de choix : l'aperçu le suit avant l'enregistrement.
  const [draft, setDraft] = useState<ThumbnailFocus | null>(null);
  const focus = draft ?? site.thumbnailFocus;
  const [watching, setWatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const captureOff = system ? !system.thumbnails.capture : false;
  const notServed = site.state !== "ONLINE" || !site.currentVersion;

  // Attente de la capture : relecture jusqu'au changement d'adresse de la vignette, ou abandon.
  useEffect(() => {
    if (watching === null) return;
    if (site.thumbnailUrl !== watching) {
      setWatching(null);
      toast.success("Vignette mise à jour");
      return;
    }
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      if (n > CAPTURE_WATCH_MAX) {
        window.clearInterval(id);
        setWatching(null);
        return;
      }
      void reloadSite();
    }, CAPTURE_WATCH_MS);
    return () => window.clearInterval(id);
  }, [watching, site.thumbnailUrl, reloadSite]);

  async function capture() {
    setBusy("capture");
    setError(null);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/thumbnail/capture`, { method: "POST" });
      onSite(updated);
      setWatching(updated.thumbnailUrl ?? "");
      toast.success("Capture relancée : la vignette arrive d'ici une minute.");
    } catch (err) {
      toast.error(errorMessage(err, "Capture impossible."));
    } finally {
      setBusy(null);
    }
  }

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
      const updated = await upload<SiteDetail>(`/api/sites/${site.id}/thumbnail`, form);
      onSite(updated);
      toast.success("Vignette remplacée");
    } catch (err) {
      const message = errorMessage(err, "Envoi de l'image impossible.");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function saveFocus() {
    setBusy("focus");
    try {
      onSite(await api<SiteDetail>(`/api/sites/${site.id}/thumbnail/focus`, { method: "PUT", json: { focus } }));
      setDraft(null);
      toast.success("Cadrage enregistré");
    } catch (err) {
      toast.error(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setBusy(null);
    }
  }

  const captureWhy = captureOff
    ? "La capture automatique n'est pas disponible sur ce serveur : envoyez une image."
    : notServed
      ? "La capture demande un site en ligne avec une version publiée."
      : null;

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Vignette du catalogue</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {site.thumbnailSource === "capture"
          ? "Capture automatique de la page d'accueil, refaite à chaque publication."
          : site.thumbnailSource === "upload"
            ? "Image envoyée à la main."
            : "Pas encore de vignette : elle est capturée après la première publication."}
      </p>
      <div className="mt-4 max-w-xl overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        <SiteThumb src={site.thumbnailUrl} frame={siteFrame(site, focus)} eager />
      </div>
      {watching !== null ? (
        <p role="status" className="mt-2 text-sm text-[var(--muted)]">
          Capture en cours…
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 [&>*]:flex-[1_1_12rem] sm:[&>*]:flex-none">
        <Button
          variant="secondary"
          onClick={() => void capture()}
          disabled={busy !== null || watching !== null || !!captureWhy}
          aria-describedby={captureWhy ? `${ids}-why` : undefined}
        >
          <FontAwesomeIcon icon={faCamera} className="h-3.5 w-3.5" aria-hidden />
          {busy === "capture" ? "Capture…" : "Reprendre la capture"}
        </Button>
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy !== null}>
          <FontAwesomeIcon icon={faImage} className="h-3.5 w-3.5" aria-hidden />
          {busy === "upload" ? "Envoi…" : "Envoyer une image"}
        </Button>
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
      {captureWhy ? (
        <p id={`${ids}-why`} className="mt-2 text-sm text-[var(--muted)]">
          {captureWhy}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-[var(--muted)]">Image PNG, JPEG ou WebP, 10 Mo au plus, gardée entière : le cadre 16:10 en montre la partie autour du point d'intérêt.</p>
      {site.thumbnailUrl ? (
        <div className="mt-5 space-y-3 border-t border-[var(--border)] pt-4">
          <FocusPicker value={focus} onChange={setDraft} disabled={busy !== null} />
          <p className="text-sm text-[var(--muted)]">
            {site.thumbnailSource === "capture"
              ? "La capture est prise au format du cadre (1280 x 800) : elle n'est pas recadrée. Le point d'intérêt compte pour une image envoyée."
              : "L'aperçu suit le point choisi ; la carte du catalogue l'affiche une fois enregistré."}
          </p>
          <Button variant="secondary" onClick={() => void saveFocus()} disabled={busy !== null || focus === site.thumbnailFocus}>
            {busy === "focus" ? "Enregistrement…" : "Enregistrer le cadrage"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
