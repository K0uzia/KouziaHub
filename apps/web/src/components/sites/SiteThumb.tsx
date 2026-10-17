import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe } from "@fortawesome/free-solid-svg-icons";

/**
 * Vignette 16:10 d'un site : image servie par le hub (privée), chargement différé ; sans image ou en échec,
 * repli sobre (surface et pictogramme), sans texte inventé. Décorative : le nom du site est écrit à côté.
 */
export function SiteThumb({
  src,
  className = "",
  eager = false,
}: {
  src: string | null;
  className?: string;
  /** Vignette visible dès l'ouverture (aperçu de la fiche) : pas de chargement différé. */
  eager?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src;
  return (
    <div className={`thumb ${className}`}>
      {show ? (
        <img
          src={src}
          alt=""
          width={1280}
          height={800}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(src)}
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <div className="thumb-empty" aria-hidden>
          <FontAwesomeIcon icon={faGlobe} className="h-9 w-9" />
        </div>
      )}
    </div>
  );
}
