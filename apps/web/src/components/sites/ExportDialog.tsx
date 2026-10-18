import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import type { ExportIssue, ExportSummary, ExportTarget, SiteDetail, VersionEntry } from "@hub/contract";
import { formatBytes, plural } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Banner } from "@/components/ui/Banner";
import { Button, buttonClass } from "@/components/ui/Button";

const TARGETS = [
  { id: "hostinger", label: "Hostinger" },
  { id: "pages", label: "Cloudflare Pages" },
] as const;

const LEVELS: Array<{ level: ExportIssue["level"]; title: string }> = [
  { level: "error", title: "À corriger avant la mise en ligne" },
  { level: "warning", title: "À vérifier" },
  { level: "info", title: "Pour information" },
];

/**
 * Résumé de la version de production avant le téléchargement : cible, contenu, écarts. Le zip est
 * téléchargé par un lien (le navigateur l'écrit au fil de l'eau, rien n'est gardé en mémoire).
 */
export function ExportDialog({
  site,
  version,
  onClose,
  onGoServer,
}: {
  site: SiteDetail;
  version: VersionEntry | null;
  onClose: () => void;
  onGoServer: () => void;
}) {
  const [target, setTarget] = useState<ExportTarget>("hostinger");
  const query = version ? `?version=${encodeURIComponent(version.id)}&target=${target}` : null;
  const summary = useResource<ExportSummary>(query ? `/api/sites/${site.id}/export/summary${query}` : null, null, { keepData: true });
  const s = summary.data && summary.data.target === target && summary.data.versionId === version?.id ? summary.data : null;
  const href = query ? `/api/sites/${site.id}/export${query}` : "#";

  return (
    <Modal
      open={version !== null}
      onClose={onClose}
      title={version ? `Version de production ${version.number}` : "Version de production"}
      description="Les fichiers à déposer chez l'hébergeur final, sans rien de propre à la version de travail."
      wide
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--text)]">Hébergement final</span>
          <Segmented options={TARGETS} value={target} onChange={setTarget} label="Hébergement final" />
          <p className="text-xs text-[var(--muted)]">
            {target === "hostinger"
              ? "Avec le fichier .htaccess (HTTPS, adresse principale, sécurité, cache, page 404)."
              : "Avec les fichiers _headers et _redirects de Cloudflare Pages."}
          </p>
        </div>

        {summary.error && !s ? (
          <Banner level="error" role="alert" action={<Button variant="ghost" onClick={() => void summary.reload()}>Réessayer</Button>}>
            {summary.error}
          </Banner>
        ) : !s ? (
          <p role="status" className="text-sm text-[var(--muted)]">
            Préparation du résumé…
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-[var(--muted)]">Fichiers</dt>
                <dd className="font-medium">{plural(s.fileCount, "fichier", "fichiers")}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--muted)]">Taille</dt>
                <dd className="font-medium">{formatBytes(s.totalBytes)}</dd>
              </div>
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <dt className="text-xs text-[var(--muted)]">Adresse principale</dt>
                <dd className="break-all font-mono text-xs">{s.canonicalOrigin ?? "Non renseignée"}</dd>
              </div>
            </dl>

            {!s.finalDomain ? (
              <Banner
                level="warning"
                action={
                  <Button variant="secondary" onClick={onGoServer}>
                    Onglet Serveur
                  </Button>
                }
              >
                Renseignez le domaine final (onglet Serveur) pour le sitemap et l'adresse principale.
              </Banner>
            ) : null}

            {LEVELS.map(({ level, title }) => {
              const issues = s.issues.filter((i) => i.level === level && i.code !== "no_final_domain");
              if (issues.length === 0) return null;
              return (
                <section key={level} aria-label={title} className="space-y-2">
                  <h3 className="text-sm font-semibold">{title}</h3>
                  {issues.map((i) => (
                    <Banner key={i.code} level={level}>
                      <p>{i.message}</p>
                      {i.paths.length ? (
                        <details className="mt-1">
                          <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs underline">
                            {i.total > i.paths.length ? `Voir les ${i.paths.length} premiers sur ${i.total}` : `Voir (${i.total})`}
                          </summary>
                          <ul className="mt-1 space-y-0.5 break-all font-mono text-xs">
                            {i.paths.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </Banner>
                  ))}
                </section>
              );
            })}

            <div className="grid gap-4 sm:grid-cols-2">
              <section aria-label="Fichiers préparés par le hub" className="min-w-0">
                <h3 className="text-sm font-semibold">Préparés par le hub</h3>
                {s.generated.length ? (
                  <ul className="mt-1 space-y-0.5 break-all font-mono text-xs text-[var(--muted)]">
                    {s.generated.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-[var(--muted)]">Aucun.</p>
                )}
              </section>
              <section aria-label="Fichiers retirés" className="min-w-0">
                <h3 className="text-sm font-semibold">Retirés</h3>
                {s.removed.length ? (
                  <ul className="mt-1 space-y-1 text-xs text-[var(--muted)]">
                    {s.removed.map((r) => (
                      <li key={r.path}>
                        <span className="break-all font-mono text-[var(--text)]">{r.path}</span> : {r.reason}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-[var(--muted)]">Aucun.</p>
                )}
              </section>
            </div>
          </>
        )}
      </div>
      <ModalActions>
        <Button variant="secondary" onClick={onClose}>
          Fermer
        </Button>
        {s ? (
          <a href={href} download={s.fileName} className={buttonClass("primary")}>
            <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" aria-hidden />
            Télécharger le zip
          </a>
        ) : (
          <Button disabled>
            <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" aria-hidden />
            Télécharger le zip
          </Button>
        )}
      </ModalActions>
    </Modal>
  );
}
