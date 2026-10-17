import { useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faCircle, faCircleCheck, faCircleXmark, faClock, faHourglassHalf, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import type { Operation, SiteDetail, StepStatus } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { OPERATION_TITLE } from "@/lib/sites";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const STEP: Record<StepStatus, { icon: IconDefinition; label: string; ink: string }> = {
  todo: { icon: faCircle, label: "À faire", ink: "text-[var(--border-strong)]" },
  running: { icon: faHourglassHalf, label: "En cours", ink: "text-[var(--info)]" },
  waiting: { icon: faClock, label: "En attente", ink: "text-[var(--warning)]" },
  done: { icon: faCircleCheck, label: "Terminé", ink: "text-[var(--success)]" },
  failed: { icon: faCircleXmark, label: "En échec", ink: "text-[var(--danger)]" },
};

/** Étapes d'une opération (création, mise en ligne, publication…) : état en texte + icône, reprise sur échec. */
export function OperationProgress({
  siteId,
  operation,
  onSite,
}: {
  siteId: string;
  operation: Operation;
  onSite: (site: SiteDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const failed = operation.status === "FAILED";
  // Opération terminée sauf le certificat (étape « waiting ») : ni échec, ni fin.
  const certWaiting = operation.status === "DONE";
  const done = operation.steps.filter((s) => s.status === "done").length;
  const current = operation.steps.find((s) => s.status === "running" || s.status === "waiting" || s.status === "failed");

  async function retry() {
    setBusy(true);
    try {
      const site = await api<SiteDetail>(`/api/sites/${siteId}/operations/${operation.id}/retry`, { method: "POST" });
      onSite(site);
      toast.success("Reprise lancée");
    } catch (err) {
      toast.error(errorMessage(err, "Reprise impossible."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={`p-4 sm:p-5 ${failed ? "border-[var(--danger)]/50" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">
            {OPERATION_TITLE[operation.kind]} : {failed ? "interrompue" : certWaiting ? "certificat en cours" : "en cours"}
          </h2>
          <p aria-live="polite" className="mt-1 text-sm text-[var(--muted)]">
            {certWaiting
              ? "Tout est prêt sauf le certificat : l'adresse répondra d'ici quelques minutes."
              : failed
              ? `Arrêt à l'étape « ${current?.label ?? "inconnue"} ».`
              : `${done} étape${done > 1 ? "s" : ""} sur ${operation.steps.length} terminée${done > 1 ? "s" : ""}${current ? `. En cours : ${current.label}.` : "."}`}
          </p>
        </div>
        {failed ? (
          <Button onClick={() => void retry()} disabled={busy}>
            <FontAwesomeIcon icon={faRotateRight} className="h-3.5 w-3.5" aria-hidden />
            {busy ? "Reprise…" : "Reprendre"}
          </Button>
        ) : null}
      </div>

      {failed && operation.error ? (
        <p role="alert" className="mt-3 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--text)]">
          {operation.error}
        </p>
      ) : null}

      <ol className="mt-4 space-y-1">
        {operation.steps.map((step) => {
          const look = STEP[step.status];
          return (
            <li key={step.key} className="flex items-start gap-3 py-1.5">
              <FontAwesomeIcon icon={look.icon} className={`mt-0.5 h-4 w-4 shrink-0 ${look.ink}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--text)]">
                  {step.label}
                  <span className={`ml-2 text-xs ${step.status === "todo" ? "text-[var(--muted)]" : look.ink}`}>{look.label}</span>
                </p>
                {step.detail ? <p className="mt-0.5 text-xs text-[var(--muted)]">{step.detail}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
