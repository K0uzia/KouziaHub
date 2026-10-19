import { useEffect, useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBoxArchive,
  faChevronRight,
  faCircleCheck,
  faCircleMinus,
  faCopy,
  faPenToSquare,
  faRotateRight,
  faShieldHalved,
} from "@fortawesome/free-solid-svg-icons";
import type { CanonicalHost, ServerConfigPreview, SiteDetail, UpdateSiteInput } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Banner } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CloudflareCacheCard } from "@/components/sites/CloudflareCacheCard";
import { SiteRulesCard } from "@/components/sites/SiteRulesCard";

const HOSTS = [
  { id: "www", label: "Avec www" },
  { id: "apex", label: "Sans www" },
] as const;

const STATE: Record<SiteDetail["serverConfig"]["status"], { icon: IconDefinition; ink: string; title: string }> = {
  generated: { icon: faCircleCheck, ink: "text-[var(--success)]", title: "Généré par le hub" },
  modified: { icon: faPenToSquare, ink: "text-[var(--warning)]", title: "Modifié à la main : le hub ne l'écrase plus" },
  missing: { icon: faCircleMinus, ink: "text-[var(--muted)]", title: "Absent des fichiers de travail" },
};

/** Profil serveur du site (hébergement final) : domaine final, forme canonique, page 404, .htaccess généré. */
export function ServerTab({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const ids = useId();
  const [finalDomain, setFinalDomain] = useState(site.finalDomain ?? "");
  const [canonicalHost, setCanonicalHost] = useState<CanonicalHost>(site.canonicalHost);
  const [notFoundPage, setNotFoundPage] = useState(site.notFoundPage);
  const [errors, setErrors] = useState<{ domain?: string; page?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const preview = useResource<ServerConfigPreview>(`/api/sites/${site.id}/server-config/preview`, null, { keepData: true });
  const reloadPreview = preview.reload;

  // Profil ou fichier changés (enregistrement, régénération, envoi dans l'explorateur) : aperçu relu.
  const signature = `${site.finalDomain}|${site.canonicalHost}|${site.notFoundPage}|${site.serverConfig.status}|${site.serverConfig.generatedAt}|${site.serverConfig.outdated}|${site.serverConfig.notFoundPagePresent}`;
  useEffect(() => {
    void reloadPreview();
  }, [signature, reloadPreview]);

  const domainSet = finalDomain.trim() !== "";
  const dirty =
    finalDomain.trim() !== (site.finalDomain ?? "") || canonicalHost !== site.canonicalHost || notFoundPage.trim() !== site.notFoundPage;
  const state = site.serverConfig;
  const look = STATE[state.status];

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const body: UpdateSiteInput = {};
    const domain = finalDomain.trim();
    if (domain !== (site.finalDomain ?? "")) body.finalDomain = domain || null;
    if (canonicalHost !== site.canonicalHost) body.canonicalHost = canonicalHost;
    if (notFoundPage.trim() !== site.notFoundPage) body.notFoundPage = notFoundPage.trim();
    setErrors({});
    setSaving(true);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}`, { method: "PATCH", json: body });
      onSite(updated);
      setFinalDomain(updated.finalDomain ?? "");
      setCanonicalHost(updated.canonicalHost);
      setNotFoundPage(updated.notFoundPage);
      toast.success(
        updated.serverConfig.status === "generated" ? "Profil enregistré, .htaccess mis à jour" : "Profil enregistré (le .htaccess modifié à la main n'est pas touché)",
      );
    } catch (err) {
      const message = errorMessage(err, "Enregistrement impossible.");
      // Erreur rattachée au champ qu'elle concerne quand un seul champ a changé.
      const keys = Object.keys(body);
      if (keys.length === 1 && keys[0] === "finalDomain") setErrors({ domain: message });
      else if (keys.length === 1 && keys[0] === "notFoundPage") setErrors({ page: message });
      else setErrors({ form: message });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function regenerate(force: boolean) {
    setRegenerating(true);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/server-config/regenerate`, { method: "POST", json: force ? { force: true } : {} });
      onSite(updated);
      setConfirm(null);
      toast.success(".htaccess régénéré");
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409 && e.code === "server_config_modified") setConfirm(e.message);
      else toast.error(errorMessage(err, "Régénération impossible."));
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="p-4 sm:p-5">
        <form onSubmit={onSave} noValidate className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Profil serveur</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Sert à préparer l'hébergement final : le hub en tire le fichier .htaccess et la configuration de la version de travail.
            </p>
          </div>
          <Field
            label="Domaine final (facultatif)"
            hint="Domaine acheté pour le client, mis en ligne à la main plus tard. Exemple : boulangerie-lefevre.fr"
            error={errors.domain}
          >
            <Input
              value={finalDomain}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              onChange={(e) => setFinalDomain(e.target.value)}
            />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-[var(--text)]">Adresse principale</span>
            <Segmented
              options={HOSTS}
              value={canonicalHost}
              onChange={setCanonicalHost}
              label="Adresse principale"
              disabled={!domainSet}
              describedBy={`${ids}-host`}
            />
            <p id={`${ids}-host`} className="text-xs text-[var(--muted)]">
              {domainSet
                ? `L'autre forme redirige vers ${canonicalHost === "www" ? `www.${finalDomain.trim()}` : finalDomain.trim()}.`
                : "Renseignez d'abord le domaine final."}
            </p>
          </div>
          <Field label="Page 404" hint="Page affichée quand une adresse n'existe pas. Forme : /404.html" error={errors.page}>
            <Input
              value={notFoundPage}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              onChange={(e) => setNotFoundPage(e.target.value)}
            />
          </Field>
          {errors.form ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {errors.form}
            </p>
          ) : null}
          <Button type="submit" disabled={!dirty || saving}>
            {saving ? "Enregistrement…" : "Enregistrer le profil"}
          </Button>
        </form>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <h2 className="text-base font-semibold">Fichier .htaccess</h2>
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <FontAwesomeIcon icon={faShieldHalved} className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
            <span>
              <span className="font-medium text-[var(--text)]">Version de travail : protections actives.</span>{" "}
              <span className="text-[var(--muted)]">
                Sur {site.hostname}, Cloudflare Pages ignore le .htaccess : le hub protège la version de travail par son _worker.js et
                son _headers (noindex, en-têtes de sécurité, 403 sur les fichiers cachés et de développement, redirection des adresses
                pages.dev).
              </span>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <FontAwesomeIcon icon={faBoxArchive} className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" aria-hidden />
            <span>
              <span className="font-medium text-[var(--text)]">
                {state.status === "modified" ? "Production : votre .htaccess modifié sera exporté tel quel." : "Production : .htaccess prêt pour l'export."}
              </span>{" "}
              <span className="text-[var(--muted)]">
                Il sert à l'hébergement final chez Hostinger, dans la version de production (onglet Versions, « Télécharger la version de
                production »). Généré, il suit le contenu publié : page 404, dossiers de fichiers hashés, sitemap.
              </span>
            </span>
          </li>
        </ul>
        <p className="flex items-start gap-2 text-sm text-[var(--text)]">
          <FontAwesomeIcon icon={look.icon} className={`mt-0.5 h-4 w-4 shrink-0 ${look.ink}`} aria-hidden />
          <span>
            {look.title}
            {state.status === "generated" && state.generatedAt ? ` le ${formatDateTime(state.generatedAt)}` : ""}.
            {state.status === "modified" && state.generatedAt ? (
              <span className="block text-xs text-[var(--muted)]">Dernière génération : {formatDateTime(state.generatedAt)}.</span>
            ) : null}
          </span>
        </p>
        {state.outdated && state.status === "generated" ? (
          <Banner level="info">
            Le contenu du site a changé (page 404, dossiers hashés ou sitemap) : le .htaccess généré sera mis à jour à la prochaine
            publication.
          </Banner>
        ) : null}
        {state.outdated && state.status === "modified" ? (
          <Banner
            level="warning"
            action={
              <Button variant="secondary" onClick={() => void regenerate(false)} disabled={regenerating}>
                Régénérer…
              </Button>
            }
          >
            La configuration générée a changé : régénérer ? Votre .htaccess modifié à la main n'est jamais remplacé sans confirmation.
          </Banner>
        ) : null}
        {!state.notFoundPagePresent ? (
          <Banner level="warning">
            La page 404 <span className="font-mono">{site.notFoundPage}</span> n'existe pas dans les fichiers de travail : ajoutez-la, ou
            changez la page 404 du profil.
          </Banner>
        ) : null}
        <Button variant="secondary" onClick={() => void regenerate(false)} disabled={regenerating}>
          <FontAwesomeIcon icon={faRotateRight} className="h-3.5 w-3.5" aria-hidden />
          {regenerating ? "Régénération…" : "Régénérer"}
        </Button>
      </Card>

      <Card className="space-y-3 p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold">Aperçu</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Lecture seule : ce que le hub génère depuis le profil et les fichiers de travail.</p>
        </div>
        {preview.error && !preview.data ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void preview.reload()}>Réessayer</Button>}>
            {preview.error}
          </Banner>
        ) : !preview.data ? (
          <p role="status" className="text-sm text-[var(--muted)]">
            Lecture de l'aperçu…
          </p>
        ) : (
          <>
            <CodeBlock title=".htaccess (hébergement final)" code={preview.data.htaccess} open />
            {preview.data.pagesHeaders ? <CodeBlock title="En-têtes envoyés à Cloudflare Pages (_headers)" code={preview.data.pagesHeaders} /> : null}
            {preview.data.pagesRedirects ? (
              <CodeBlock title="Redirections envoyées à Cloudflare Pages (_redirects)" code={preview.data.pagesRedirects} />
            ) : null}
            <p className="text-xs text-[var(--muted)]">
              {preview.data.hubCacheRules
                ? "Règles de cache ajoutées par le hub."
                : "Le site pose lui-même ses règles de cache dans _headers : le hub n'en ajoute pas."}
            </p>
          </>
        )}
      </Card>

      <SiteRulesCard site={site} onSite={onSite} />

      <CloudflareCacheCard site={site} />

      <ConfirmDialog
        open={confirm !== null}
        title="Remplacer le .htaccess ?"
        message={
          <>
            <p>{confirm}</p>
            <p className="mt-2 text-[var(--muted)]">
              {state.status === "modified"
                ? "La modification faite à la main sera perdue : le fichier sera remplacé par la version générée depuis le profil."
                : "Le fichier sera recréé depuis le profil."}
            </p>
          </>
        }
        confirmLabel={state.status === "modified" ? "Remplacer le .htaccess" : "Recréer le .htaccess"}
        danger={state.status === "modified"}
        busy={regenerating}
        onConfirm={() => void regenerate(true)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

/** Code en lecture seule, repliable : police mono, défilement horizontal interne, bouton Copier. */
function CodeBlock({ title, code, open = false }: { title: string; code: string; open?: boolean }) {
  return (
    <details open={open} className="code-details">
      <summary className="code-summary">
        <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
        {title}
      </summary>
      <div className="mt-2 space-y-2">
        <pre tabIndex={0} aria-label={title} className="code-block">
          <code>{code}</code>
        </pre>
        <Button variant="ghost" onClick={() => void copyText(code, "Copié")}>
          <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" aria-hidden />
          Copier
        </Button>
      </div>
    </details>
  );
}
