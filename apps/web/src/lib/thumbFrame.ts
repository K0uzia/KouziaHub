import type { SiteSummary, SoftwareSummary, SoftwareThumbnailFit, ThumbnailFocus } from "@hub/contract";

/** Cadrage d'une vignette à l'affichage : l'image est gardée à son ratio, le cadre 16:10 la montre ainsi. */
export type ThumbFrame = {
  /** cover : remplit le cadre (capture) ; contain : entière et centrée, avec une marge (logo). */
  fit: "cover" | "contain";
  /** object-position CSS d'une image qui remplit le cadre. */
  position: string;
  /** Fond d'un logo, null : fond neutre du thème. */
  background: string | null;
};

export const FOCUS_POSITION: Record<ThumbnailFocus, string> = {
  "haut-gauche": "left top",
  haut: "center top",
  "haut-droite": "right top",
  gauche: "left center",
  centre: "center center",
  droite: "right center",
  "bas-gauche": "left bottom",
  bas: "center bottom",
  "bas-droite": "right bottom",
};

export const FOCUS_LABEL: Record<ThumbnailFocus, string> = {
  "haut-gauche": "En haut à gauche",
  haut: "En haut au centre",
  "haut-droite": "En haut à droite",
  gauche: "Au milieu à gauche",
  centre: "Au centre",
  droite: "Au milieu à droite",
  "bas-gauche": "En bas à gauche",
  bas: "En bas au centre",
  "bas-droite": "En bas à droite",
};

export const siteFrame = (s: Pick<SiteSummary, "thumbnailFocus">, focus: ThumbnailFocus = s.thumbnailFocus): ThumbFrame => ({
  fit: "cover",
  position: FOCUS_POSITION[focus],
  background: null,
});

/** Image d'avant le réglage (fit null) : déjà recadrée au format du cadre, affichée telle quelle. */
export function softwareFrame(s: Pick<SoftwareSummary, "thumbnailFit" | "thumbnailColor">, fit: SoftwareThumbnailFit | null = s.thumbnailFit): ThumbFrame {
  if (fit === "logo" || fit === "logo-couleur") return { fit: "contain", position: "center", background: fit === "logo-couleur" ? s.thumbnailColor : null };
  return { fit: "cover", position: "center top", background: null };
}
