import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { checkSoftwareField, type CreateSoftwareInput, type SoftwareDetail, type SoftwareField } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { cleanSlugInput } from "@/lib/slug";
import { keygenCommand, prefixFrom, softwareSlugFrom } from "@/lib/software";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";

type Form = Required<{ [K in keyof CreateSoftwareInput]: string }>;
const EMPTY: Form = { name: "", slug: "", keyPrefix: "", description: "", demoUrl: "", releasesUrl: "" };
const ORDER: SoftwareField[] = ["name", "slug", "keyPrefix", "description", "demoUrl", "releasesUrl"];

/**
 * Création d'un logiciel, sur le modèle de « Nouveau site » : nom, identifiant proposé depuis le nom (modifiable),
 * préfixe des clés proposé depuis l'identifiant. La clé de signature se crée ensuite sur le serveur, jamais ici.
 */
export function NewSoftwareDialog({
  open,
  onClose,
  taken,
}: {
  open: boolean;
  onClose: () => void;
  /** Identifiants et préfixes déjà pris (catalogue lu) : refus immédiat, le serveur reste seul juge. */
  taken: { slugs: string[]; prefixes: string[] };
}) {
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(EMPTY);
  const [touched, setTouched] = useState({ slug: false, keyPrefix: false });
  const [errors, setErrors] = useState<Partial<Record<SoftwareField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setTouched({ slug: false, keyPrefix: false });
    setErrors({});
    setServerError(null);
  }, [open]);

  function set(field: SoftwareField, value: string) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      // Identifiant et préfixe suivent le nom tant qu'ils n'ont pas été modifiés à la main.
      if (field === "name" && !touched.slug) next.slug = softwareSlugFrom(value);
      if ((field === "name" || field === "slug") && !touched.keyPrefix) next.keyPrefix = prefixFrom(next.slug);
      return next;
    });
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function validate(): Partial<Record<SoftwareField, string>> {
    const found: Partial<Record<SoftwareField, string>> = {};
    for (const f of ORDER) {
      const checked = checkSoftwareField(f, form[f]);
      if (!checked.ok) found[f] = checked.error;
    }
    if (!found.slug && taken.slugs.includes(form.slug.trim())) found.slug = `L'identifiant ${form.slug.trim()} est déjà pris.`;
    if (!found.keyPrefix && taken.prefixes.includes(form.keyPrefix.trim())) found.keyPrefix = `Le préfixe ${form.keyPrefix.trim()} est déjà pris.`;
    return found;
  }

  function focusFirst(found: Partial<Record<SoftwareField, string>>) {
    const first = ORDER.find((f) => found[f]);
    if (first) document.getElementById(`nouveau-logiciel-${first}`)?.focus();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const found = validate();
    setErrors(found);
    if (Object.values(found).some(Boolean)) {
      focusFirst(found);
      return;
    }
    setBusy(true);
    try {
      const body: CreateSoftwareInput = {
        name: form.name,
        slug: form.slug.trim(),
        keyPrefix: form.keyPrefix.trim(),
        description: form.description || null,
        demoUrl: form.demoUrl || null,
        releasesUrl: form.releasesUrl || null,
      };
      const created = await api<SoftwareDetail>("/api/logiciels", { method: "POST", json: body });
      toast.success(`${created.software.name} ajouté. Clé de signature : ${keygenCommand(created.software.slug)} sur le serveur.`);
      onClose();
      navigate(`/logiciels/${created.software.slug}`);
    } catch (err) {
      const message = errorMessage(err, "Création impossible.");
      const code = (err as ApiError).code as SoftwareField | undefined;
      if (code && ORDER.includes(code)) {
        setErrors({ [code]: message });
        focusFirst({ [code]: message });
      } else setServerError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const input = (field: SoftwareField) => ({
    id: `nouveau-logiciel-${field}`,
    value: form[field],
    autoComplete: "off",
    onChange: (e: { target: { value: string } }) => set(field, e.target.value),
  });

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title="Nouveau logiciel" description="Ses clés de licence seront signées avec sa propre paire, créée sur le serveur.">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <Field label="Nom" error={errors.name}>
          <Input {...input("name")} required maxLength={80} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Identifiant" hint="Minuscules, chiffres et tirets. Ne change plus." error={errors.slug}>
            <Input
              {...input("slug")}
              required
              maxLength={32}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              onChange={(e) => {
                setTouched((t) => ({ ...t, slug: true }));
                set("slug", cleanSlugInput(e.target.value).slice(0, 32));
              }}
            />
          </Field>
          <Field label="Préfixe des clés" hint="2 à 8 majuscules ou chiffres (TB1 réservé). Ne change plus." error={errors.keyPrefix}>
            <Input
              {...input("keyPrefix")}
              required
              maxLength={8}
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono"
              onChange={(e) => {
                setTouched((t) => ({ ...t, keyPrefix: true }));
                set("keyPrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8));
              }}
            />
          </Field>
        </div>
        <Field label="Description (facultative)" error={errors.description}>
          <Textarea {...input("description")} rows={3} maxLength={500} />
        </Field>
        <Field label="Démo ou site (facultatif)" error={errors.demoUrl}>
          <Input {...input("demoUrl")} type="url" inputMode="url" placeholder="https://" />
        </Field>
        <Field label="Page des versions publiées (facultative)" hint="Exemple : la page des releases du dépôt." error={errors.releasesUrl}>
          <Input {...input("releasesUrl")} type="url" inputMode="url" placeholder="https://" />
        </Field>

        {serverError ? (
          <p role="alert" className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {serverError}
          </p>
        ) : null}

        <ModalActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Création…" : "Créer le logiciel"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
