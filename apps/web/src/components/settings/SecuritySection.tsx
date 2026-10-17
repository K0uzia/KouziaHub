import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy, faShieldHalved } from "@fortawesome/free-solid-svg-icons";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, plural } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { CodeInput } from "@/components/ui/CodeInput";

type Status = { enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number };
type Setup = { secret: string; otpauthUri: string; qrSvg: string };
type Step = "idle" | "setup" | "regenerate";

/** QR code renvoyé en SVG par le hub : affiché par une image (data URL), jamais inséré dans le DOM. */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SecuritySection() {
  const ids = useId();
  const status = useResource<Status>("/api/auth/2fa/status");
  const [step, setStep] = useState<Step>("idle");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== "idle") codeRef.current?.focus();
  }, [step, setup]);

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Setup>("/api/auth/2fa/setup", { method: "POST" });
      setSetup(res);
      setCode("");
      setCodes(null);
      setStep("setup");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (code.length !== 6) {
      setError("Saisissez les 6 chiffres affichés par l'application.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = step === "setup" ? "/api/auth/2fa/enable" : "/api/auth/2fa/recovery-codes";
      const res = await api<{ recoveryCodes: string[] }>(path, { method: "POST", json: { code } });
      setCodes(res.recoveryCodes);
      toast.success(step === "setup" ? "Double authentification activée" : "Nouveaux codes de secours créés");
      setStep("idle");
      setSetup(null);
      setCode("");
      void status.reload();
    } catch (err) {
      setError(errorMessage(err, "Code incorrect."));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setStep("idle");
    setSetup(null);
    setCode("");
    setError(null);
  }

  const s = status.data;

  return (
    <section id="securite" aria-labelledby={`${ids}-title`} className="scroll-mt-4">
      <h2 id={`${ids}-title`} className="mb-3 text-lg font-semibold">
        Sécurité
      </h2>
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <FontAwesomeIcon icon={faShieldHalved} className="h-4 w-4 text-[var(--primary)]" aria-hidden />
              Double authentification
            </h3>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Un code à 6 chiffres de votre application (Google Authenticator, Aegis…) en plus du mot de passe.
            </p>
          </div>
          {s ? <Badge tone={s.enabled ? "green" : "amber"}>{s.enabled ? "Activée" : "Non activée"}</Badge> : null}
        </div>

        {status.loading ? (
          <p role="status" className="text-sm text-[var(--muted)]">
            Lecture…
          </p>
        ) : status.error && !s ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void status.reload()}>Réessayer</Button>}>
            {status.error}
          </Banner>
        ) : s ? (
          s.enabled ? (
            <p className="text-sm text-[var(--text)]">
              {s.enabledAt ? `Activée le ${formatDate(s.enabledAt)}. ` : ""}
              {plural(s.recoveryCodesRemaining, "code de secours restant", "codes de secours restants")}.
            </p>
          ) : (
            <Banner level="warning">Sans double authentification, la connexion par Internet au hub est refusée.</Banner>
          )
        ) : null}

        {codes ? (
          <div className="space-y-3 rounded-[var(--radius)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] p-4" role="status">
            <p className="text-sm font-medium text-[var(--text)]">
              Codes de secours : notez-les en lieu sûr. Chacun ne sert qu'une fois, et ils ne seront plus affichés.
            </p>
            <ul className="grid grid-cols-1 gap-2 font-mono text-base text-[var(--text)] min-[22rem]:grid-cols-2">
              {codes.map((c) => (
                <li key={c} className="rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] px-3 py-2 text-center tracking-wider">
                  {c}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void copyText(codes.join("\n"), "Codes copiés")}>
                <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" aria-hidden />
                Copier les codes
              </Button>
              <Button variant="ghost" onClick={() => setCodes(null)}>
                J'ai noté les codes
              </Button>
            </div>
          </div>
        ) : null}

        {step === "setup" && setup ? (
          <form onSubmit={onSubmitCode} className="space-y-4 border-t border-[var(--border)] pt-4" noValidate>
            <ol className="list-decimal space-y-4 pl-5 text-sm text-[var(--text)]">
              <li>
                Scannez ce QR code avec l'application.
                <img
                  src={svgDataUrl(setup.qrSvg)}
                  alt="QR code de la double authentification du hub"
                  width={192}
                  height={192}
                  className="mt-3 h-48 w-48 rounded-[var(--radius-sm)] bg-[var(--qr-bg)] p-2"
                />
              </li>
              <li>
                Ou saisissez cette clé dans l'application :
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="break-all rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-sm">{setup.secret}</code>
                  <Button variant="ghost" onClick={() => void copyText(setup.secret, "Clé copiée")}>
                    <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" aria-hidden />
                    Copier la clé
                  </Button>
                </span>
              </li>
              <li>
                <label htmlFor={`${ids}-code`} className="block">
                  Saisissez le code à 6 chiffres affiché.
                </label>
                <div className="mt-2">
                  <CodeInput
                    id={`${ids}-code`}
                    ref={codeRef}
                    value={code}
                    onChange={setCode}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${ids}-error` : undefined}
                  />
                </div>
              </li>
            </ol>
            {error ? (
              <p id={`${ids}-error`} role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Vérification…" : "Activer"}
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={busy}>
                Annuler
              </Button>
            </div>
          </form>
        ) : step === "regenerate" ? (
          <form onSubmit={onSubmitCode} className="space-y-3 border-t border-[var(--border)] pt-4" noValidate>
            <label htmlFor={`${ids}-code`} className="block text-sm font-medium text-[var(--text)]">
              Code de l'application, pour confirmer
            </label>
            <CodeInput
              id={`${ids}-code`}
              ref={codeRef}
              value={code}
              onChange={setCode}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${ids}-regen-hint${error ? ` ${ids}-error` : ""}`}
            />
            <p id={`${ids}-regen-hint`} className="text-sm text-[var(--muted)]">
              Les anciens codes de secours ne fonctionneront plus.
            </p>
            {error ? (
              <p id={`${ids}-error`} role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Vérification…" : "Créer de nouveaux codes"}
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={busy}>
                Annuler
              </Button>
            </div>
          </form>
        ) : s ? (
          <div>
            {s.enabled ? (
              <Button variant="secondary" onClick={() => setStep("regenerate")}>
                Régénérer les codes de secours
              </Button>
            ) : (
              <Button onClick={() => void startSetup()} disabled={busy}>
                {busy ? "Préparation…" : "Activer la double authentification"}
              </Button>
            )}
          </div>
        ) : null}
      </Card>
    </section>
  );
}
