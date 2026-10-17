import { useEffect, useId, useState } from "react";
import { Command } from "cmdk";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import type { ErpClient } from "@hub/contract";
import { api, errorMessage, isAbort } from "@/lib/api";
import { useDebounced } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Field";

const TYPE_LABEL: Record<ErpClient["type"], string> = {
  B2B: "Professionnel",
  B2C: "Particulier",
  ASSOCIATION: "Association",
};

type Lookup = { status: "idle" | "loading" | "done" | "error"; clients: ErpClient[]; available: boolean; error: string | null };

/**
 * Choix d'un client lu dans l'ERP (lecture seule) : recherche côté serveur (GET /api/erp/clients?q=), liste
 * au clavier (cmdk : flèches, Entrée). Client choisi : affiché avec « Changer ».
 */
export function ClientPicker({
  value,
  onChange,
  error,
  errorId,
  label = "Client",
}: {
  value: ErpClient | null;
  onChange: (client: ErpClient | null) => void;
  error?: string | null;
  errorId?: string;
  label?: string;
}) {
  const inputId = useId();
  const listHintId = useId();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const [lookup, setLookup] = useState<Lookup>({ status: "idle", clients: [], available: true, error: null });

  useEffect(() => {
    if (value) return;
    const ctrl = new AbortController();
    setLookup((l) => ({ ...l, status: "loading" }));
    api<{ clients: ErpClient[]; available: boolean }>(`/api/erp/clients?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
      .then((res) => setLookup({ status: "done", clients: res.clients, available: res.available, error: null }))
      .catch((err) => {
        if (isAbort(err)) return;
        setLookup({ status: "error", clients: [], available: true, error: errorMessage(err, "Lecture des clients impossible.") });
      });
    return () => ctrl.abort();
  }, [q, value]);

  if (value) {
    return (
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-[var(--text)]">{value.displayName}</span>
            <span className="block text-xs text-[var(--muted)]">
              {TYPE_LABEL[value.type]}
              {value.clientNumber ? `, n° ${value.clientNumber}` : ""}
            </span>
          </span>
          <Button variant="ghost" onClick={() => onChange(null)}>
            Changer
          </Button>
        </div>
      </div>
    );
  }

  const describedBy = [error ? errorId : null, listHintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-[var(--text)]">
        {label}
      </label>
      <Command shouldFilter={false} label={label} className="client-picker">
        <div className="relative">
          <FontAwesomeIcon
            icon={faMagnifyingGlass}
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
            aria-hidden
          />
          <Command.Input
            id={inputId}
            value={query}
            onValueChange={setQuery}
            placeholder="Nom ou numéro du client"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={`${inputClass} pl-9`}
          />
        </div>
        <p id={listHintId} className="mt-1.5 text-xs text-[var(--muted)]">
          Liste lue dans l'ERP. Flèches pour parcourir, Entrée pour choisir.
        </p>
        {error ? (
          <p id={errorId} className="mt-1 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}
        <Command.List className="mt-2 max-h-60 overflow-y-auto overscroll-contain rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-1">
          {lookup.status === "loading" && lookup.clients.length === 0 ? (
            <Command.Loading>
              <p className="px-3 py-3 text-sm text-[var(--muted)]">Recherche…</p>
            </Command.Loading>
          ) : null}
          {lookup.status === "error" ? (
            <p className="px-3 py-3 text-sm text-[var(--danger)]">{lookup.error}</p>
          ) : !lookup.available ? (
            <p className="px-3 py-3 text-sm text-[var(--warning)]">
              L'ERP ne répond pas : impossible de lire les clients pour l'instant. Réessayez plus tard, ou créez un site perso.
            </p>
          ) : lookup.status === "done" ? (
            <Command.Empty className="px-3 py-3 text-sm text-[var(--muted)]">
              {q ? `Aucun client ne correspond à « ${q} ».` : "Aucun client dans l'ERP."}
            </Command.Empty>
          ) : null}
          {lookup.clients.map((c) => (
            <Command.Item
              key={c.id}
              value={c.id}
              onSelect={() => onChange(c)}
              className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--text)] data-[selected=true]:bg-[var(--primary-soft)]"
            >
              <span className="min-w-0 truncate">{c.displayName}</span>
              <span className="shrink-0 text-xs text-[var(--muted)]">
                {c.clientNumber ? `n° ${c.clientNumber}` : TYPE_LABEL[c.type]}
              </span>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
