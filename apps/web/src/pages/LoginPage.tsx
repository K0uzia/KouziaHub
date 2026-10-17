import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/api";
import { useTitle } from "@/lib/useTitle";
import { Button } from "@/components/ui/Button";
import { CodeInput } from "@/components/ui/CodeInput";
import { Field, Input } from "@/components/ui/Field";
import { BrandMark } from "@/components/BrandMark";

export function LoginPage() {
  const { user, loading, login, verifySecondFactor } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Étape 2 : mot de passe accepté, code de l'application (ou code de secours) attendu.
  const [step, setStep] = useState<"password" | "code">("password");
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const returningRef = useRef(false);
  useTitle(step === "code" ? "Double authentification" : "Connexion");

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
    if (step === "password" && returningRef.current) {
      returningRef.current = false;
      passwordRef.current?.focus();
    }
  }, [step, useRecovery]);

  if (!loading && user) return <Navigate to={from} replace />;

  function done() {
    toast.success("Connecté");
    navigate(from, { replace: true });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if ((await login(email, password)) === "mfa") {
        setPassword("");
        setCode("");
        setStep("code");
      } else {
        done();
      }
    } catch (err) {
      setError(errorMessage(err, "Échec de connexion."));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifySecondFactor(useRecovery ? { recoveryCode: code } : { code });
      done();
    } catch (err) {
      const message = errorMessage(err, "Code incorrect.");
      // Connexion expirée : retour au mot de passe.
      if (/expirée/.test(message)) {
        returningRef.current = true;
        setStep("password");
      }
      setError(message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  function backToPassword() {
    returningRef.current = true;
    setStep("password");
    setUseRecovery(false);
    setError(null);
  }

  const errorBox = error ? (
    <p
      id="login-error"
      role="alert"
      className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
    >
      {error}
    </p>
  ) : null;

  return (
    <main id="contenu" className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark className="h-12 w-12" />
          <p className="mt-4 font-display text-xl font-semibold tracking-wide">
            Kouzia <span className="text-[var(--primary)]">Hub</span>
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">Versions de travail des sites clients</p>
        </div>

        {step === "code" ? (
          <form onSubmit={onSubmitCode} className="ui-card space-y-5 p-6 sm:p-8">
            <h1 className="text-lg font-semibold">Double authentification</h1>
            <p className="text-sm text-[var(--muted)]">
              {useRecovery
                ? "Saisissez un de vos codes de secours (il ne servira plus ensuite)."
                : "Saisissez le code à 6 chiffres affiché par votre application d'authentification."}
            </p>
            {errorBox}
            {useRecovery ? (
              <Field label="Code de secours">
                <Input
                  ref={codeRef}
                  required
                  autoComplete="one-time-code"
                  maxLength={20}
                  value={code}
                  className="font-mono tracking-[0.2em]"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "login-error" : undefined}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Code">
                <CodeInput
                  ref={codeRef}
                  value={code}
                  onChange={setCode}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "login-error" : undefined}
                />
              </Field>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Vérification…" : "Valider"}
            </Button>
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode("");
                  setError(null);
                }}
              >
                {useRecovery ? "Utiliser l'application" : "Utiliser un code de secours"}
              </Button>
              <Button variant="ghost" onClick={backToPassword}>
                Retour
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={onSubmit} className="ui-card space-y-5 p-6 sm:p-8">
            <h1 className="text-lg font-semibold">Connexion</h1>
            {errorBox}
            <Field label="E-mail">
              <Input
                type="email"
                required
                autoComplete="username"
                value={email}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Mot de passe">
              <Input
                ref={passwordRef}
                type="password"
                required
                autoComplete="current-password"
                value={password}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Connexion…" : "Se connecter"}
            </Button>
          </form>
        )}
        <p className="mt-6 text-center text-xs text-[var(--muted)]">Accès réservé. Les connexions sont limitées en nombre.</p>
      </div>
    </main>
  );
}
