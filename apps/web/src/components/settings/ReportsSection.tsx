import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { checkReportField, type ReportSettings } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { reportsStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Tile } from "@/components/ui/Tile";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@/components/ui/Button";
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

/**
 * Tuile Rapports : coordonnées imprimées en bas des rapports mensuels (un champ vide n'affiche rien) ;
 * le formulaire est dans un dépliant, ouvert d'office tant qu'une erreur y est signalée.
 */
export function ReportsSection() {
  const [open, setOpen] = useState(false);
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
    if (Object.keys(found).length) setOpen(true);
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
      setOpen(false);
    } catch (err) {
      const field = (err as ApiError).field as Key | undefined;
      if (field && FIELDS.some((f) => f.key === field)) {
        setErrors({ [field]: errorMessage(err) });
        setOpen(true);
        inputs.current[field]?.focus();
      } else {
        toast.error(errorMessage(err, "Enregistrement impossible."));
      }
    } finally {
      setBusy(false);
    }
  }

  const saved = settings.data;
  const shown = saved ? FIELDS.filter((f) => saved[f.key]) : [];

  return (
    <Tile id="rapports" className="scroll-mt-4" title="Rapports" level={2} tip="report" status={reportsStatus({ data: saved, error: settings.error })}>
      {settings.loading && !saved ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture…
        </p>
      ) : settings.error && !saved ? (
        <Button variant="ghost" className="self-start" onClick={() => void settings.reload()}>
          Réessayer
        </Button>
      ) : (
        <>
          {shown.length ? (
            <dl className="space-y-1">
              {shown.map((f) => (
                <div key={f.key} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <dt className="text-xs text-[var(--muted)]">{f.label}</dt>
                  <dd className="min-w-0 break-all text-sm text-[var(--text)]">{toValues(saved!)[f.key]}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <details className="code-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary className="code-summary">
              <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
              Modifier les coordonnées
            </summary>
            <form onSubmit={onSubmit} className="space-y-4 pb-1" noValidate>
              <p className="text-sm text-[var(--muted)]">Imprimées dans le pied de page de chaque rapport. Un champ laissé vide n'apparaît pas.</p>
              <div className="grid gap-4">
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
          </details>
        </>
      )}
    </Tile>
  );
}
