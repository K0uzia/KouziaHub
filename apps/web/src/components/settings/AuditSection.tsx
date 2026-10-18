import { useId, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faCircleXmark } from "@fortawesome/free-solid-svg-icons";
import type { AuditEntry } from "@hub/contract";
import { formatDateTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";

const PAGE = 50;
const MAX = 500;

/**
 * Libellés des actions du journal. Une action inconnue de cette table s'affiche telle que le serveur
 * l'écrit (rien d'inventé) ; table à compléter quand le serveur ajoute une action.
 */
const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Connexion",
  "site.create": "Création du site",
  "site.update": "Modification du site",
  "site.enable": "Remise en ligne",
  "site.disable": "Mise hors ligne",
  "site.delete": "Suppression du site",
  "site.certificate": "Certificat de l'adresse",
  "version.publish": "Publication",
  "version.republish": "Republication d'une version",
  "files.upload": "Envoi de fichiers",
  "files.delete": "Suppression de fichiers",
  "files.move": "Renommage",
  "files.zip": "Envoi d'un zip",
  "files.restore": "Restauration d'une version",
  "thumbnail.upload": "Vignette envoyée",
  "thumbnail.capture": "Capture de la vignette",
  "orphan.delete": "Suppression d'un enregistrement DNS orphelin",
  "files.purge": "Fichiers de travail vidés",
  "versions.purge": "Anciennes versions supprimées",
  "cache.purge": "Place libérée sur le hub",
  "cache.cloudflare.purge": "Cache Cloudflare vidé",
  "version.export": "Version de production téléchargée",
};

export function AuditSection() {
  const ids = useId();
  const [limit, setLimit] = useState(PAGE);
  const audit = useResource<AuditEntry[]>(`/api/audit?limit=${limit}`, null, { keepData: true });
  const list = audit.data ?? [];

  return (
    <section id="journal" aria-labelledby={`${ids}-title`} className="scroll-mt-4">
      <h2 id={`${ids}-title`} className="mb-3 text-lg font-semibold">
        Journal
      </h2>
      {audit.loading && !audit.data ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture du journal…
        </p>
      ) : audit.error && !audit.data ? (
        <Banner level="error" action={<Button variant="ghost" onClick={() => void audit.reload()}>Réessayer</Button>}>
          {audit.error}
        </Banner>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState title="Aucune action enregistrée pour l'instant." />
        </Card>
      ) : (
        <>
          <div className="ui-card ui-table-wrap max-md:border-0 max-md:bg-transparent max-md:shadow-none">
            <table className="ui-table ui-table-stack">
              <caption className="sr-only">Dernières actions, de la plus récente à la plus ancienne</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Action</th>
                  <th scope="col">Site</th>
                  <th scope="col">Résultat</th>
                  <th scope="col">Détail</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Date" className="nowrap">
                      {formatDateTime(e.at)}
                    </td>
                    <td data-label="Action" className="wrap">
                      {ACTION_LABEL[e.action] ?? <span className="font-mono text-xs">{e.action}</span>}
                    </td>
                    <td data-label="Site" className="wrap">
                      {e.siteSlug ? <span className="font-mono">{e.siteSlug}</span> : <span className="text-[var(--muted)]">Aucun</span>}
                    </td>
                    <td data-label="Résultat" className="nowrap">
                      {e.result === "ok" ? (
                        <span className="inline-flex items-center gap-1.5 text-[var(--success)]">
                          <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5" aria-hidden />
                          Réussi
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[var(--danger)]">
                          <FontAwesomeIcon icon={faCircleXmark} className="h-3.5 w-3.5" aria-hidden />
                          Échec
                        </span>
                      )}
                    </td>
                    <td data-label="Détail" className="wrap text-[var(--muted)]">
                      {e.detail ?? <span className="text-[var(--muted)]">Aucun</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length >= limit && limit < MAX ? (
            <div className="mt-3">
              <Button variant="secondary" onClick={() => setLimit((l) => Math.min(MAX, l + PAGE * 2))}>
                Afficher plus
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
