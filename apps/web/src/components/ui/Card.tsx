import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";

const tones = {
  neutral: "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]",
  primary: "bg-[var(--primary-soft)] text-[var(--primary)]",
  green: "bg-[var(--success-soft)] text-[var(--success)]",
  amber: "bg-[var(--warning-soft)] text-[var(--warning)]",
  red: "bg-[var(--danger-soft)] text-[var(--danger)]",
  blue: "bg-[var(--info-soft)] text-[var(--info)]",
  violet: "bg-[var(--accent-2-soft)] text-[var(--accent-2)]",
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium leading-none ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Lien de retour vers la liste parente (affiché au-dessus du titre). */
  back?: { to: string; label: string };
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {back ? (
          <Link
            to={back.to}
            className="-ml-1 mb-1 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-1 text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            <FontAwesomeIcon icon={faArrowLeft} className="h-3.5 w-3.5" aria-hidden />
            {back.label}
          </Link>
        ) : null}
        <h1 className="break-words text-xl font-bold leading-tight tracking-tight text-[var(--text)] sm:text-2xl lg:text-3xl">
          {title}
        </h1>
        {subtitle ? <div className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--muted)]">{subtitle}</div> : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:max-w-[min(100%,32rem)] sm:justify-end [&>*]:flex-[1_1_8rem] sm:[&>*]:flex-none">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function Card({
  children,
  className = "",
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-card ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Titre de section dans une carte : h2 et texte d'aide. */
export function SectionTitle({ title, hint, id }: { title: string; hint?: ReactNode; id?: string }) {
  return (
    <div className="mb-4">
      <h2 id={id} className="text-base font-semibold text-[var(--text)]">
        {title}
      </h2>
      {hint ? <p className="mt-1 text-sm text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}

/** État vide : ce qui manque, et en option l'action qui le crée. */
export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="px-6 py-14 text-center">
      {icon ? (
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-raised)] text-[var(--muted)]">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-medium text-[var(--text)]">{title}</p>
      {hint ? <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--muted)]">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
