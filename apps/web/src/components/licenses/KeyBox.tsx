import { Field, Textarea } from "@/components/ui/Field";

/** Clé TB1 en lecture seule, sélectionnable d'un geste (copie à la main si le presse-papiers est refusé). */
export function KeyBox({ value }: { value: string }) {
  return (
    <Field label="Clé de licence">
      <Textarea
        readOnly
        value={value}
        rows={4}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        className="break-all font-mono text-xs leading-relaxed"
      />
    </Field>
  );
}
