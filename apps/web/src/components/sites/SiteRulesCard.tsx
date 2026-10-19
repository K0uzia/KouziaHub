import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { SiteDetail, UpdateSiteInput } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";

/** CSP posée par le hub sur la version de travail quand le site n'en a pas (aucun script, style ou image restreint). */
const MINIMAL_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests";

/**
 * Règles du site, onglet Serveur : exceptions aux fichiers de développement refusés (un site statique qui sert
 * vraiment un package.json ou un dossier src/), et CSP du site (version de travail et .htaccess de l'export).
 */
export function SiteRulesCard({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const [allow, setAllow] = useState(site.devFilesAllowed.join("\n"));
  const [csp, setCsp] = useState(site.siteCsp ?? "");
  const [errors, setErrors] = useState<{ allow?: string; csp?: string }>({});
  const [saving, setSaving] = useState(false);
  const allowList = allow.split("\n").map((l) => l.trim()).filter(Boolean);
  const dirty = allowList.join("\n") !== site.devFilesAllowed.join("\n") || csp.trim() !== (site.siteCsp ?? "");

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setSaving(true);
    const body: UpdateSiteInput = { devFilesAllowed: allowList, siteCsp: csp.trim() || null };
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}`, { method: "PATCH", json: body });
      onSite(updated);
      setAllow(updated.devFilesAllowed.join("\n"));
      setCsp(updated.siteCsp ?? "");
      toast.success("Règles du site enregistrées : elles s'appliquent à la prochaine publication");
    } catch (err) {
      const code = (err as ApiError).code;
      const message = errorMessage(err, "Enregistrement impossible.");
      if (code === "dev_files_allowed") setErrors({ allow: message });
      else if (code === "site_csp") setErrors({ csp: message });
      else toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Règles du site</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Appliquées à la version de travail (au prochain déploiement) et au .htaccess de l'export.
      </p>
      <form onSubmit={onSave} noValidate className="mt-4 space-y-4">
        <Field
          label="Fichiers de développement autorisés (facultatif)"
          hint="Un chemin exact par ligne (50 au plus, ni dossier ni joker) : package.json, tsconfig.json, src/... sont refusés et jamais servis ; exception pour un site qui en a vraiment besoin, ex. data/package.json."
          error={errors.allow}
        >
          <Textarea
            value={allow}
            rows={3}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            onChange={(e) => setAllow(e.target.value)}
          />
        </Field>
        <Field
          label="CSP du site (facultatif)"
          hint={`Une seule ligne. Sans elle : CSP minimale sur la version de travail (${MINIMAL_CSP}) et CSP par défaut du hub dans l'export. Renseignée, chacune de ses directives s'y ajoute ou remplace la même directive, sauf frame-ancestors et object-src, toujours imposées.`}
          error={errors.csp}
        >
          <Input
            value={csp}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            placeholder="default-src 'self'; img-src 'self' data:"
            onChange={(e) => setCsp(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={!dirty || saving}>
          {saving ? "Enregistrement…" : "Enregistrer les règles"}
        </Button>
      </form>
    </Card>
  );
}
