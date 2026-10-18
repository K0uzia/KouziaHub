import { useId, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faCircleXmark, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import type { GlossaryKey } from "@/lib/glossary";
import type { TileStatus } from "@/lib/settingsStatus";
import { Badge } from "@/components/ui/Card";
import { Explain } from "@/components/ui/InfoTip";

const STATUS_LOOK = {
  ok: { icon: faCircleCheck, tone: "green" },
  todo: { icon: faTriangleExclamation, tone: "amber" },
  error: { icon: faCircleXmark, tone: "red" },
} as const;

/**
 * Tuile d'une grille bento (classe .bento) : section titrée, explication « ? » facultative à côté du titre
 * (hors du titre, pour garder un nom de titre court). span : 2 colonnes quand la grille en a 2 ou plus ;
 * full : toute la ligne. status : état en un coup d'œil (Configuré, À faire, Erreur) en texte et en icône,
 * avec sa raison en une ligne.
 */
export function Tile({
  title,
  level,
  tip,
  tone,
  span,
  status,
  id: anchor,
  className = "",
  children,
}: {
  title: ReactNode;
  level: 2 | 3 | 4;
  tip?: GlossaryKey;
  /** Bordure d'état, toujours doublée d'un texte dans la tuile. */
  tone?: "warn" | "bad";
  span?: 2 | "full";
  status?: TileStatus | null;
  /** Ancre de la tuile (lien vers /reglages#notifications). */
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const Heading = level === 2 ? "h2" : level === 3 ? "h3" : "h4";
  const spanClass = span === 2 ? "tile-span-2" : span === "full" ? "tile-full" : "";
  const look = status ? STATUS_LOOK[status.level] : null;
  const border = tone ?? (status?.level === "error" ? "bad" : status?.level === "todo" ? "warn" : undefined);
  return (
    <section id={anchor} className={`tile ${spanClass} ${className}`} data-tone={border} aria-labelledby={id}>
      <div className="tile-head">
        <Heading id={id} className="tile-title">
          {title}
        </Heading>
        {tip ? <Explain k={tip} /> : null}
        {status && look ? (
          <Badge tone={look.tone} className="ml-auto">
            <FontAwesomeIcon icon={look.icon} className="h-3 w-3" aria-hidden />
            {status.label}
          </Badge>
        ) : null}
      </div>
      {status ? <p className="text-sm text-[var(--text)]">{status.reason}</p> : null}
      {children}
    </section>
  );
}
