import type { ErpClient } from "@hub/contract";
import { Button } from "@/components/ui/Button";
import { ClientPicker } from "@/components/sites/ClientPicker";

export type LinkedClient = { id: string; name: string | null };

/**
 * Client de l'ERP d'une clé de licence, facultatif : choisi par le ClientPicker de « Nouveau site ». Une clé déjà
 * liée n'a que l'identifiant et le nom lus dans l'ERP ; le nom manque si l'ERP ne répond pas.
 */
export function ErpClientField({
  value,
  onChange,
  onPicked,
  label = "Client de l'ERP (facultatif)",
}: {
  value: LinkedClient | null;
  onChange: (client: LinkedClient | null) => void;
  /** Client choisi dans la liste (pour proposer son nom ailleurs dans le formulaire). */
  onPicked?: (client: ErpClient) => void;
  label?: string;
}) {
  if (!value) {
    return (
      <ClientPicker
        value={null}
        label={label}
        onChange={(c) => {
          if (!c) return;
          onChange({ id: c.id, name: c.displayName });
          onPicked?.(c);
        }}
      />
    );
  }
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-[var(--text)]">{value.name ?? "Client que l'ERP ne renvoie pas pour l'instant"}</span>
        <Button variant="ghost" onClick={() => onChange(null)}>
          Changer ou retirer
        </Button>
      </div>
    </div>
  );
}
