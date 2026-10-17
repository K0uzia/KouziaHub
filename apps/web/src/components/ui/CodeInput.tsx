import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type Ref } from "react";

// Saisie d'un code à 6 chiffres (double authentification), sur le modèle de l'espace client du site :
// UN SEUL vrai champ (inputMode numeric, autocomplete one-time-code), affiché en 6 cases décoratives
// (aria-hidden). Collage nettoyé (« 123 456 », « 123-456 », texte autour) ; envoi automatique du
// formulaire, une seule fois par code complet, le bouton restant présent. Aucune lecture du presse-papiers.
// Écrit ici : pas de bibliothèque légère qui garde un seul champ natif (les « OTP inputs » en ont 6).

export const CODE_LENGTH = 6;

/** Les 6 chiffres d'un texte collé (espaces, tirets, points et texte autour ignorés), sinon null. */
export function extractCode(text: string): string | null {
  const m = /\d{6}/.exec(text.replace(/[\s.-]/g, ""));
  return m ? m[0] : null;
}

type Caret = { focused: boolean; start: number; end: number };

export function CodeInput({
  value,
  onChange,
  autoSubmit = true,
  ref,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
}: {
  value: string;
  onChange: (code: string) => void;
  /** Envoie le formulaire dès 6 chiffres (une fois par code). */
  autoSubmit?: boolean;
  ref?: Ref<HTMLInputElement>;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState<Caret>({ focused: false, start: 0, end: 0 });
  const sent = useRef("");
  const invalid = ariaInvalid === true || ariaInvalid === "true";

  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  const read = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    setCaret({ focused: document.activeElement === el, start, end: el.selectionEnd ?? start });
  }, []);

  // Les cases suivent le curseur et la sélection du vrai champ (flèches, Origine, Fin, souris).
  useEffect(() => {
    const onSelection = () => {
      if (document.activeElement === inputRef.current) read();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [read]);

  // Envoi après la mise à jour de l'état (le gestionnaire du formulaire lit la valeur complète).
  useEffect(() => {
    if (value.length < CODE_LENGTH) {
      sent.current = "";
      return;
    }
    if (!autoSubmit || value === sent.current) return;
    sent.current = value;
    inputRef.current?.form?.requestSubmit();
  }, [value, autoSubmit]);

  const set = (raw: string) => onChange(raw.replace(/\D/g, "").slice(0, CODE_LENGTH));

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const code = extractCode(e.clipboardData.getData("text"));
    if (!code) return;
    e.preventDefault();
    onChange(code);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(CODE_LENGTH, CODE_LENGTH);
      read();
    });
  };

  const collapsed = caret.start === caret.end;
  return (
    <div className="relative w-full max-w-[22rem]">
      <input
        ref={setRefs}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={CODE_LENGTH}
        spellCheck={false}
        required
        value={value}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => set(e.target.value)}
        onPaste={onPaste}
        onFocus={read}
        onBlur={read}
        onSelect={read}
        onKeyUp={read}
        onClick={read}
        // Texte, curseur et sélection natifs invisibles : les cases les affichent. Contour porté par les cases.
        className="peer absolute inset-0 z-10 h-full w-full border-0 bg-transparent p-0 text-base text-transparent caret-transparent selection:bg-transparent selection:text-transparent focus-visible:outline-none"
      />
      <div
        aria-hidden="true"
        className="grid grid-cols-6 gap-1.5 rounded-[var(--radius-sm)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-[var(--primary)]"
      >
        {Array.from({ length: CODE_LENGTH }, (_, i) => {
          const active = caret.focused && collapsed && i === Math.min(caret.start, CODE_LENGTH - 1);
          const after = active && caret.start >= CODE_LENGTH;
          const chosen = caret.focused && !collapsed && i >= caret.start && i < caret.end;
          const tone = invalid
            ? "border-[var(--danger)]"
            : active
              ? "border-[var(--primary)] shadow-[inset_0_-3px_0_var(--primary)]"
              : "border-[var(--border-strong)]";
          return (
            <span
              key={i}
              className={`relative grid min-h-11 place-items-center rounded-[var(--radius-sm)] border font-mono text-xl tabular-nums text-[var(--text)] ${tone} ${
                chosen ? "bg-[var(--primary-soft)]" : "bg-[var(--surface-raised)]"
              }`}
            >
              {value[i] ?? ""}
              {active ? (
                // Point d'insertion : avant le chiffre, ou après le dernier quand le code est complet.
                <span
                  className={`absolute top-1/4 h-1/2 w-0.5 bg-[var(--primary)] ${
                    after ? "left-[calc(50%+0.45em)]" : value[i] ? "left-[calc(50%-0.55em)]" : "left-1/2 -translate-x-1/2"
                  }`}
                />
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
