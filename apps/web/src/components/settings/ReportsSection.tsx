import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFilePdf } from "@fortawesome/free-solid-svg-icons";
import { checkReportField, type ReportSettings } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { useResource } from "@/lib/useResource";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Field, Input } from "@/components/ui/Field";

type Key = keyof ReportSettings;
type Values = Record<Key, string>;

const FIELDS: Array<{ key: Key; label: string; hint: string; type: string; autoComplete: string; inputMode?: "tel" | "email" | "url"; placeholder?: string }> = [
  { key: "displayName", label: "Nom affiché", hint: "« Rapport préparé par … ». Vide : Kouzia.", type: "text", autoComplete: "organization" },
  { key: "email", label: "E-mail de contact", hint: "Exemple : nom@domaine.fr", type: "email", autoComplete: "email", inputMode: "email" },
  { key: "phone", label: "Téléphone", hint: "Numéro français : 06 12 34 56 78 ou +33 6 12 34 56 78.", type: "tel", autoComplete: "tel", inputMode: "tel" },
  { key: "website", label: "Site web", hint: "Adresse complète en https://", type: "url", autoComplete: "url", inputMode: "url", placeholder: "https://" },
];

const EMPTY: Values = { displayName: "", email: "", phone: "", website: "" };

/** Valeur enregistrée vers le champ : téléphone lisible par paires. */
function toValues(s: ReportSettings): Values {
  return {
    displayName: s.displayName ?? "",
    email: s.email ?? "",
    phone: s.phone ? (s.phone.match(/\d\d/g) ?? [s.phone]).join(" ") : "",
    website: s.website ?? "",
  };
}

/** Coordonnées imprimées en bas des rapports mensuels ; un champ vide n'affiche rien. */
export function ReportsSection() {
  const ids = useId();
  const settings = useResource<ReportSettings>("/api/settings/reports");
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Partial<Record<Key, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (settings.data) setValues(toValues(settings.data));
  }, [settings.data]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found: Partial<Record<Key, string>> = {};
    for (const { key } of FIELDS) {
      const checked = checkReportField(key, values[key]);
      if (!checked.ok) found[key] = checked.error;
    }
    setErrors(found);
    const first = FIELDS.find((f) => found[f.key]);
    if (first) {
      inputs.current[first.key]?.focus();
      return;
    }
    setBusy(true);
    try {
      const saved = await api<ReportSettings>("/api/settings/reports", { method: "PATCH", json: values });
      settings.setData(saved);
      toast.success("Coordonnées des rapports enregistrées");
    } catch (err) {
      const field = (err as ApiError).field as Key | undefined;
      if (field && FIELDS.some((f) => f.key === field)) {
        setErrors({ [field]: errorMessage(err) });
        inputs.current[field]?.focus();
      } else {
        toast.error(errorMessage(err, "Enregistrement impossible."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="rapports" aria-labelledby={`${ids}-title`} className="scroll-mt-4">
      <h2 id={`${ids}-title`} className="mb-3 text-lg font-semibold">
        Rapports
      </h2>
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <FontAwesomeIcon icon={faFilePdf} className="h-4 w-4 text-[var(--primary)]" aria-hidden />
            Coordonnées en bas du rapport mensuel
          </h3>
          <p className="mt-1 text-sm text-[var(--muted)]">Imprimées dans le pied de page de chaque rapport. Un champ laissé vide n'apparaît pas.</p>
        </div>

        {settings.loading && !settings.data ? (
          <p role="status" className="text-sm text-[var(--muted)]">
            Lecture…
          </p>
        ) : settings.error && !settings.data ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void settings.reload()}>Réessayer</Button>}>
            {settings.error}
          </Banner>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
                  <Input
                    ref={(el) => {
                      inputs.current[f.key] = el;
                    }}
                    name={f.key}
                    type={f.type}
                    autoComplete={f.autoComplete}
                    inputMode={f.inputMode}
                    placeholder={f.placeholder}
                    maxLength={f.key === "displayName" ? 80 : 200}
                    value={values[f.key]}
                    onChange={(e) => {
                      const value = e.target.value;
                      setValues((v) => ({ ...v, [f.key]: value }));
                      if (errors[f.key]) setErrors((x) => ({ ...x, [f.key]: undefined }));
                    }}
                  />
                </Field>
              ))}
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </form>
        )}
      </Card>
    </section>
  );
}
