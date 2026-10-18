import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy, faShieldHalved } from "@fortawesome/free-solid-svg-icons";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Tile } from "@/components/ui/Tile";
import { securityStatus } from "@/lib/settingsStatus";
import { CodeInput } from "@/components/ui/CodeInput";

type Status = { enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number };
type Setup = { secret: string; otpauthUri: string; qrSvg: string };
type Step = "idle" | "setup" | "regenerate";

/** QR code renvoyé en SVG par le hub : affiché par une image (data URL), jamais inséré dans le DOM. */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Tuile Compte et sécurité : état de la double authentification ; activation et codes de secours dans une modale. */
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
  // Bouton de la tuile (Activer ou Régénérer) : il reprend le focus à la fermeture de la modale.
  const actionsRef = useRef<HTMLDivElement>(null);
  const refocus = () => requestAnimationFrame(() => actionsRef.current?.querySelector("button")?.focus());

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
    refocus();
  }

  function closeCodes() {
    setCodes(null);
    refocus();
  }

  const s = status.data;

  return (
    <Tile id="securite" className="scroll-mt-4" title="Compte et sécurité" level={2} status={securityStatus({ data: s, error: status.error })}>
      {status.loading ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture…
        </p>
      ) : status.error && !s ? (
        <Button variant="ghost" className="self-start" onClick={() => void status.reload()}>
          Réessayer
        </Button>
      ) : s ? (
        <>
          <p className="text-sm text-[var(--muted)]">
            Un code à 6 chiffres de votre application (Google Authenticator, Aegis…) en plus du mot de passe.
            {s.enabled && s.enabledAt ? ` Activée le ${formatDate(s.enabledAt)}.` : ""}
          </p>
          <div ref={actionsRef} className="mt-auto flex flex-wrap gap-2 pt-1">
            {s.enabled ? (
              <Button variant="secondary" onClick={() => setStep("regenerate")}>
                Régénérer les codes de secours
              </Button>
            ) : (
              <Button onClick={() => void startSetup()} disabled={busy}>
                <FontAwesomeIcon icon={faShieldHalved} className="h-3.5 w-3.5" aria-hidden />
                {busy ? "Préparation…" : "Activer la double authentification"}
              </Button>
            )}
          </div>
        </>
      ) : null}

      <Modal
        open={step !== "idle" || codes !== null}
        onClose={codes ? closeCodes : cancel}
        title={codes ? "Codes de secours" : step === "setup" ? "Activer la double authentification" : "Régénérer les codes de secours"}
      >
        {codes ? (
          <div className="space-y-3" role="status">
            <p className="text-sm font-medium text-[var(--text)]">
              Notez-les en lieu sûr. Chacun ne sert qu'une fois, et ils ne seront plus affichés.
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
              <Button onClick={closeCodes}>J'ai noté les codes</Button>
            </div>
          </div>
        ) : step === "setup" && setup ? (
          <form onSubmit={onSubmitCode} className="space-y-4" noValidate>
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
          <form onSubmit={onSubmitCode} className="space-y-3" noValidate>
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
        ) : null}
      </Modal>
    </Tile>
  );
}
