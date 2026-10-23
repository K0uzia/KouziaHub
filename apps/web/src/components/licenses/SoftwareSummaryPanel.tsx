import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faChevronRight, faCopy } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareDetail } from "@hub/contract";
import { copyText } from "@/lib/clipboard";
import { keygenCommand } from "@/lib/software";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link inline-flex min-h-6 items-center gap-1.5 break-all">
      {children}
      <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">(nouvel onglet)</span>
    </a>
  );
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

/** Synthèse de la fiche d'un logiciel (colonne de droite, comme celle d'un site). */
export function SoftwareSummaryPanel({ detail }: { detail: SoftwareDetail }) {
  const s = detail.software;
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold">Synthèse</h2>
      <dl className="space-y-3 text-sm">
        {s.description ? (
          <div>
            <dt className="text-xs text-[var(--muted)]">Description</dt>
            <dd className="mt-0.5 whitespace-pre-line break-words text-[var(--text)]">{s.description}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-[var(--muted)]">Identifiant</dt>
          <dd className="mt-0.5 break-all font-mono text-[var(--text)]">{s.slug}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Format des clés</dt>
          <dd className="mt-0.5 text-[var(--text)]">
            <span className="font-mono">{s.keyPrefix}.…</span>
            <span className="block text-xs text-[var(--muted)]">
              {s.format === "TB1" ? "Format TB1, propre à Tracebay." : `Format générique KZ1, champ « logiciel » signé (${s.slug}).`}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Clé de signature</dt>
          <dd className="mt-0.5 text-[var(--text)]">
            {detail.signing ? (
              "En place sur le serveur"
            ) : (
              <>
                <span className="text-[var(--warning)]">Absente : émission impossible</span>
                <span className="block text-xs text-[var(--muted)]">
                  Sur le serveur : <code className="break-words font-mono">{keygenCommand(s.slug)}</code>
                </span>
              </>
            )}
          </dd>
        </div>
        {s.demoUrl ? (
          <div>
            <dt className="text-xs text-[var(--muted)]">Démo ou site</dt>
            <dd className="mt-0.5">
              <ExternalLink href={s.demoUrl}>{hostOf(s.demoUrl)}</ExternalLink>
            </dd>
          </div>
        ) : null}
        {s.releasesUrl ? (
          <div>
            <dt className="text-xs text-[var(--muted)]">Versions publiées</dt>
            <dd className="mt-0.5">
              <ExternalLink href={s.releasesUrl}>{hostOf(s.releasesUrl)}</ExternalLink>
            </dd>
          </div>
        ) : null}
      </dl>

      {detail.publicKey ? (
        <details className="code-details mt-4 border-t border-[var(--border)] pt-1">
          <summary className="code-summary">
            <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
            Clé publique à embarquer
          </summary>
          <p className="mt-1 text-xs text-[var(--muted)]">Publique, sans secret : le logiciel vérifie ses clés avec elle, hors ligne.</p>
          <pre className="mt-2 overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-2 font-mono text-xs text-[var(--text)]">{detail.publicKey.trim()}</pre>
          <Button variant="secondary" className="mt-2" onClick={() => void copyText(detail.publicKey!, "Clé publique copiée")}>
            <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" aria-hidden />
            Copier la clé publique
          </Button>
        </details>
      ) : null}
    </Card>
  );
}
