import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleInfo, faCircleExclamation, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";

const looks = {
  info: { icon: faCircleInfo, box: "border-[var(--info)]/40 bg-[var(--info-soft)]", ink: "text-[var(--info)]", word: "Information" },
  warning: {
    icon: faTriangleExclamation,
    box: "border-[var(--warning)]/40 bg-[var(--warning-soft)]",
    ink: "text-[var(--warning)]",
    word: "Attention",
  },
  error: {
    icon: faCircleExclamation,
    box: "border-[var(--danger)]/40 bg-[var(--danger-soft)]",
    ink: "text-[var(--danger)]",
    word: "Erreur",
  },
} as const;

/** Bandeau d'avertissement : niveau dit en texte (lecteur d'écran) et par l'icône, pas seulement par la couleur. */
export function Banner({
  level = "info",
  children,
  action,
  role,
  id,
  className = "",
}: {
  level?: keyof typeof looks;
  children: ReactNode;
  action?: ReactNode;
  /** « alert » pour une erreur qui vient d'arriver, « status » pour un résultat ; rien pour un état durable. */
  role?: "alert" | "status";
  id?: string;
  className?: string;
}) {
  const look = looks[level];
  return (
    <div
      id={id}
      role={role}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--text)] ${look.box} ${className}`}
    >
      <FontAwesomeIcon icon={look.icon} className={`mt-0.5 h-4 w-4 shrink-0 ${look.ink}`} aria-hidden />
      <div className="min-w-0 flex-[1_1_9rem] leading-relaxed">
        <span className="sr-only">{look.word} : </span>
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
