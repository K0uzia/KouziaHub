import { useId, type ReactNode } from "react";
import type { GlossaryKey } from "@/lib/glossary";
import { Explain } from "@/components/ui/InfoTip";

/**
 * Tuile d'une grille bento (classe .bento) : section titrée, explication « ? » facultative à côté du titre
 * (hors du titre, pour garder un nom de titre court). span : 2 colonnes quand la grille en a 2 ou plus ;
 * full : toute la ligne.
 */
export function Tile({
  title,
  level,
  tip,
  tone,
  span,
  className = "",
  children,
}: {
  title: ReactNode;
  level: 2 | 3 | 4;
  tip?: GlossaryKey;
  /** Bordure d'état, toujours doublée d'un texte dans la tuile. */
  tone?: "warn" | "bad";
  span?: 2 | "full";
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const Heading = level === 2 ? "h2" : level === 3 ? "h3" : "h4";
  const spanClass = span === 2 ? "tile-span-2" : span === "full" ? "tile-full" : "";
  return (
    <section className={`tile ${spanClass} ${className}`} data-tone={tone} aria-labelledby={id}>
      <div className="tile-head">
        <Heading id={id} className="tile-title">
          {title}
        </Heading>
        {tip ? <Explain k={tip} /> : null}
      </div>
      {children}
    </section>
  );
}
