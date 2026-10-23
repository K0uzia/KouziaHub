import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { checkSoftwareField, type SoftwareDetail, type SoftwareField, type UpdateSoftwareInput } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";

type Editable = "name" | "description" | "demoUrl" | "releasesUrl";
const FIELDS: Editable[] = ["name", "description", "demoUrl", "releasesUrl"];
const valuesOf = (d: SoftwareDetail): Record<Editable, string> => ({
  name: d.software.name,
  description: d.software.description ?? "",
  demoUrl: d.software.demoUrl ?? "",
  releasesUrl: d.software.releasesUrl ?? "",
});

/** Réglages d'un logiciel : nom, description et liens ; identifiant et préfixe figés (ils sont dans les clés). */
export function SoftwareSettingsTab({ detail, onDetail }: { detail: SoftwareDetail; onDetail: (d: SoftwareDetail) => void }) {
  const navigate = useNavigate();
  const ids = useId();
  const s = detail.software;
  const [form, setForm] = useState(() => valuesOf(detail));
  const [errors, setErrors] = useState<Partial<Record<Editable, string>>>({});
  const [saving, setSaving] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const saved = valuesOf(detail);
  const dirty = FIELDS.some((f) => form[f].trim() !== saved[f]);
  const issued = s.counts.active + s.counts.expiring + s.counts.expired;
  const deletable = s.slug !== "tracebay" && issued === 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    const found: Partial<Record<Editable, string>> = {};
    for (const f of FIELDS) {
      const checked = checkSoftwareField(f as SoftwareField, form[f]);
      if (!checked.ok) found[f] = checked.error;
    }
    setErrors(found);
    const first = FIELDS.find((f) => found[f]);
    if (first) {
      document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const body: UpdateSoftwareInput = {};
      if (form.name.trim() !== saved.name) body.name = form.name.trim();
      for (const f of ["description", "demoUrl", "releasesUrl"] as const) if (form[f].trim() !== saved[f]) body[f] = form[f].trim() || null;
      const updated = await api<SoftwareDetail>(`/api/logiciels/${s.slug}`, { method: "PATCH", json: body });
      onDetail(updated);
      setForm(valuesOf(updated));
      toast.success("Fiche enregistrée");
    } catch (err) {
      const message = errorMessage(err, "Enregistrement impossible.");
      const code = (err as ApiError).code as Editable | undefined;
      if (code && FIELDS.includes(code)) setErrors({ [code]: message });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(e: FormEvent) {
    e.preventDefault();
    if (confirmText.trim() !== s.slug) {
      setDeleteError(`Saisissez exactement « ${s.slug} ».`);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/logiciels/${s.slug}`, { method: "DELETE" });
      toast.success(`${s.name} supprimé`);
      navigate("/logiciels", { replace: true });
    } catch (err) {
      const message = errorMessage(err, "Suppression impossible.");
      setDeleteError(message);
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  }

  const bind = (f: Editable) => ({
    id: `${ids}-${f}`,
    value: form[f],
    autoComplete: "off",
    onChange: (e: { target: { value: string } }) => {
      setForm((prev) => ({ ...prev, [f]: e.target.value }));
      setErrors((prev) => ({ ...prev, [f]: undefined }));
    },
  });

  return (
    <div className="space-y-5">
      <Card className="p-4 sm:p-5">
        <form onSubmit={save} noValidate className="space-y-4">
          <h2 className="text-base font-semibold">Fiche du logiciel</h2>
          <Field label="Nom" error={errors.name}>
            <Input {...bind("name")} required maxLength={80} />
          </Field>
          <Field label="Description (facultative)" error={errors.description}>
            <Textarea {...bind("description")} rows={3} maxLength={500} />
          </Field>
          <Field label="Démo ou site (facultatif)" error={errors.demoUrl}>
            <Input {...bind("demoUrl")} type="url" inputMode="url" placeholder="https://" />
          </Field>
          <Field label="Page des versions publiées (facultative)" error={errors.releasesUrl}>
            <Input {...bind("releasesUrl")} type="url" inputMode="url" placeholder="https://" />
          </Field>
          <p className="text-sm text-[var(--muted)]">
            L'identifiant <span className="font-mono text-[var(--text)]">{s.slug}</span> et le préfixe <span className="font-mono text-[var(--text)]">{s.keyPrefix}</span>{" "}
            sont écrits dans les clés et le nom du fichier de signature : ils ne changent plus.
          </p>
          <Button type="submit" variant="secondary" disabled={!dirty || saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </form>
      </Card>

      {s.slug === "tracebay" ? null : (
        <Card className="border-[var(--danger)]/40 p-4 sm:p-5">
          <form onSubmit={onDelete} noValidate className="space-y-4" aria-labelledby={`${ids}-del`}>
            <h2 id={`${ids}-del`} className="text-base font-semibold text-[var(--danger)]">
              Supprimer le logiciel
            </h2>
            {deletable ? (
              <>
                <p className="text-sm text-[var(--text)]">
                  Aucune clé n'a été émise : la fiche et sa vignette sont supprimées. La clé de signature reste sur le serveur.
                </p>
                <Field label={`Pour confirmer, saisissez l'identifiant : ${s.slug}`} error={deleteError ?? undefined}>
                  <Input
                    value={confirmText}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(e) => {
                      setConfirmText(e.target.value);
                      setDeleteError(null);
                    }}
                  />
                </Field>
                <Button type="submit" variant="danger" disabled={deleting || confirmText.trim() !== s.slug}>
                  <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
                  {deleting ? "Suppression…" : `Supprimer ${s.name}`}
                </Button>
              </>
            ) : (
              <p className="text-sm text-[var(--text)]">Des clés ont été émises pour ce logiciel : il reste au registre, avec ses licences.</p>
            )}
          </form>
        </Card>
      )}
    </div>
  );
}
