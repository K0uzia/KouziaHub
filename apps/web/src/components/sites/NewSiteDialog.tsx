import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faCircleExclamation } from "@fortawesome/free-solid-svg-icons";
import type { CreateSiteInput, ErpClient, PhpServerStatus, SiteDetail, SiteKind, SlugCheck } from "@hub/contract";
import { api, errorMessage, isAbort, type ApiError } from "@/lib/api";
import { cleanSlugInput, slugify } from "@/lib/slug";
import { phpHostingChoice } from "@/lib/sites";
import { useDebounced, useResource } from "@/lib/useResource";
import { useSitesDomain } from "@/lib/system";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { Field, Input, inputClass } from "@/components/ui/Field";
import { ClientPicker } from "@/components/sites/ClientPicker";

type Check = { status: "idle" | "checking" | "ok" | "bad" | "error"; reason: string | null; slug: string };

const HOSTINGS = [
  { id: "pages", label: "Statique" },
  { id: "php", label: "PHP" },
] as const;

const KINDS = [
  { id: "CLIENT", label: "Client de l'ERP" },
  { id: "PERSO", label: "Perso" },
] as const;

/** Création d'un site : client (ERP) ou perso, sous-domaine proposé et contrôlé en direct, un seul bouton. */
export function NewSiteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const domain = useSitesDomain();
  const slugId = useId();
  const slugNoteId = useId();
  const clientErrorId = useId();
  const [kind, setKind] = useState<SiteKind>("CLIENT");
  const [client, setClient] = useState<ErpClient | null>(null);
  const [label, setLabel] = useState("");
  // Site PHP (docs/cadrage.md, section 11) : proposé quand le serveur des sites PHP répond ; sinon la raison est dite.
  const phpServer = useResource<PhpServerStatus>("/api/php/serveur");
  const phpChoice = phpHostingChoice(phpServer.data, phpServer.error !== null);
  const phpVersions = phpChoice?.versions ?? [];
  const [hosting, setHosting] = useState<"pages" | "php">("pages");
  const [phpVersion, setPhpVersion] = useState("8.3");
  const [publicDir, setPublicDir] = useState("public");
  const [persistent, setPersistent] = useState("");
  // Version proposée : 8.3 si installée, sinon la première du serveur.
  const chosenPhp = phpVersions.includes(phpVersion) ? phpVersion : (phpVersions[0] ?? phpVersion);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [check, setCheck] = useState<Check>({ status: "idle", reason: null, slug: "" });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  // Réouverture : formulaire vierge.
  useEffect(() => {
    if (!open) return;
    setKind("CLIENT");
    setClient(null);
    setLabel("");
    setSlug("");
    setSlugTouched(false);
    setCheck({ status: "idle", reason: null, slug: "" });
    setSubmitted(false);
    setServerError(null);
    setHosting("pages");
    setPhpVersion("8.3");
    setPublicDir("public");
    setPersistent("");
  }, [open]);

  // Sous-domaine proposé depuis le nom du client (ou le libellé d'un site perso) tant qu'il n'a pas été modifié.
  // Proposition immédiate en local, puis celle du serveur (GET slug-check?name=), qui fait foi et arrive vérifiée.
  const source = slugTouched ? "" : kind === "CLIENT" ? (client?.displayName ?? "") : label;
  const debouncedSource = useDebounced(source, 300);
  useEffect(() => {
    if (slugTouched) return;
    setSlug(slugify(source));
  }, [source, slugTouched]);
  useEffect(() => {
    if (!open || slugTouched || !debouncedSource.trim()) return;
    const ctrl = new AbortController();
    api<SlugCheck>(`/api/sites/slug-check?name=${encodeURIComponent(debouncedSource)}`, { signal: ctrl.signal })
      .then((res) => {
        if (!res.slug) return;
        setCheck({ status: res.ok ? "ok" : "bad", reason: res.reason, slug: res.slug });
        setSlug(res.slug);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [debouncedSource, open, slugTouched]);

  const debouncedSlug = useDebounced(slug, 400);
  useEffect(() => {
    if (!open) return;
    if (!debouncedSlug) {
      setCheck({ status: "idle", reason: null, slug: "" });
      return;
    }
    // Déjà vérifié (proposition du serveur) : pas de second appel.
    if (checkRef.current.slug === debouncedSlug && (checkRef.current.status === "ok" || checkRef.current.status === "bad")) return;
    const ctrl = new AbortController();
    setCheck({ status: "checking", reason: null, slug: debouncedSlug });
    api<SlugCheck>(`/api/sites/slug-check?slug=${encodeURIComponent(debouncedSlug)}`, { signal: ctrl.signal })
      .then((res) => setCheck({ status: res.ok ? "ok" : "bad", reason: res.reason, slug: res.slug }))
      .catch((err) => {
        if (isAbort(err)) return;
        setCheck({ status: "error", reason: errorMessage(err, "Vérification impossible."), slug: debouncedSlug });
      });
    return () => ctrl.abort();
  }, [debouncedSlug, open]);

  const checkRef = useRef(check);
  checkRef.current = check;
  const checkFresh = check.slug === slug;
  const clientError = submitted && kind === "CLIENT" && !client ? "Choisissez le client du site." : null;
  const labelError = submitted && kind === "PERSO" && !label.trim() ? "Donnez un nom à ce site perso." : null;
  const slugError = !slug
    ? submitted
      ? "Indiquez le sous-domaine."
      : null
    : checkFresh && (check.status === "bad" || check.status === "error")
      ? (check.reason ?? "Ce sous-domaine n'est pas disponible.")
      : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (kind === "CLIENT" && !client) {
      document.getElementById(`${slugId}-client`)?.querySelector("input")?.focus();
      return;
    }
    if (kind === "PERSO" && !label.trim()) {
      labelRef.current?.focus();
      return;
    }
    if (!slug || (checkFresh && check.status === "bad")) {
      slugRef.current?.focus();
      return;
    }
    const php =
      hosting === "php"
        ? {
            hosting: "php" as const,
            php: { version: chosenPhp, publicDir: publicDir.trim().replace(/^\/+|\/+$/g, ""), persistentDirs: persistent.split(/[\s,]+/).filter(Boolean) },
          }
        : {};
    const body: CreateSiteInput =
      kind === "CLIENT"
        ? { kind, erpClientId: client!.id, slug, label: label.trim() || null, ...php }
        : { kind, slug, label: label.trim(), ...php };
    setBusy(true);
    try {
      const site = await api<SiteDetail>("/api/sites", { method: "POST", json: body });
      toast.success(`Création de ${site.hostname} lancée`);
      onClose();
      navigate(`/sites/${site.id}`);
    } catch (err) {
      const message = errorMessage(err, "Création impossible.");
      // 409 : sous-domaine pris entre-temps ; la raison s'affiche sous le champ.
      if ((err as ApiError).status === 409) {
        setCheck({ status: "bad", reason: message, slug });
        slugRef.current?.focus();
      } else setServerError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const slugStatus =
    slugError ? null : !slug ? null : !checkFresh || check.status === "checking" ? (
      <span className="text-[var(--muted)]">Vérification…</span>
    ) : check.status === "ok" ? (
      <span className="inline-flex items-center gap-1.5 text-[var(--success)]">
        <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5" aria-hidden />
        Disponible
      </span>
    ) : null;

  const createLabel = slug ? `Créer ${slug}.${domain}` : "Créer le site";

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title="Nouveau site" description="Le site est créé sur son adresse, protégé de l'indexation.">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div className="space-y-1.5">
          <span id={`${slugId}-kind`} className="block text-sm font-medium text-[var(--text)]">
            Pour qui ?
          </span>
          <Segmented
            options={KINDS}
            value={kind}
            onChange={(k) => {
              setKind(k);
              setSubmitted(false);
            }}
            label="Pour qui ?"
            className="w-full"
          />
        </div>

        {kind === "CLIENT" ? (
          <div id={`${slugId}-client`}>
            <ClientPicker value={client} onChange={setClient} error={clientError} errorId={clientErrorId} />
          </div>
        ) : null}

        <Field
          label={kind === "PERSO" ? "Nom du site" : "Libellé (facultatif)"}
          hint={kind === "CLIENT" ? "Sinon, le nom du client est affiché." : undefined}
          error={labelError ?? undefined}
        >
          <Input
            ref={labelRef}
            value={label}
            required={kind === "PERSO"}
            autoComplete="off"
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        <div className="space-y-1.5">
          <label htmlFor={slugId} className="block text-sm font-medium text-[var(--text)]">
            Sous-domaine
          </label>
          <div className="flex min-w-0 items-stretch">
            <input
              ref={slugRef}
              id={slugId}
              value={slug}
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              aria-invalid={slugError ? true : undefined}
              aria-describedby={slugNoteId}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(cleanSlugInput(e.target.value));
              }}
              className={`${inputClass} min-w-0 flex-1 rounded-r-none font-mono`}
            />
            <span className="inline-flex shrink-0 items-center rounded-r-[var(--radius)] border border-l-0 border-[var(--border-input)] bg-[var(--bg-subtle)] px-3 font-mono text-sm text-[var(--muted)]">
              .{domain}
            </span>
          </div>
          <p id={slugNoteId} aria-live="polite" className="min-h-5 text-sm">
            {slugError ? (
              <span className="inline-flex items-start gap-1.5 text-[var(--danger)]">
                <FontAwesomeIcon icon={faCircleExclamation} className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {slugError}
              </span>
            ) : (
              slugStatus ?? <span className="text-[var(--muted)]">Minuscules, chiffres et tirets.</span>
            )}
          </p>
        </div>

        {phpVersions.length ? (
          <div className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-3">
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-[var(--text)]">Hébergement de la version de travail</span>
              <Segmented
                options={HOSTINGS}
                value={hosting}
                onChange={setHosting}
                label="Hébergement de la version de travail"
                stack
                className="w-full"
              />
              <p className="text-xs text-[var(--muted)]">
                {hosting === "php"
                  ? "Site dynamique (PHP, base de données) : hébergé sur le serveur des sites PHP du Proxmox, jamais publié chez Cloudflare Pages."
                  : "Site statique (HTML, CSS, JS) : Cloudflare Pages."}
              </p>
            </div>
            {hosting === "php" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Version de PHP">
                  <select value={chosenPhp} onChange={(e) => setPhpVersion(e.target.value)} className={inputClass}>
                    {phpVersions.map((v) => (
                      <option key={v} value={v}>
                        PHP {v}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Dossier public" hint="Seul dossier servi (vide : racine du projet).">
                  <Input value={publicDir} onChange={(e) => setPublicDir(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
                </Field>
                <Field label="Dossiers persistants (facultatif)" hint="Gardés d'une version à l'autre, jamais servis : données, fichiers envoyés (ex. data)." className="sm:col-span-2">
                  <Input value={persistent} onChange={(e) => setPersistent(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" placeholder="data" />
                </Field>
              </div>
            ) : null}
          </div>
        ) : phpChoice?.unavailable ? (
          <p className="rounded-[var(--radius)] border border-[var(--border)] p-3 text-xs text-[var(--muted)]">
            <span className="block text-sm font-medium text-[var(--text)]">Hébergement : Cloudflare Pages (site statique)</span>
            Site PHP indisponible : {phpChoice.unavailable}
          </p>
        ) : null}

        {serverError ? (
          <p role="alert" className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {serverError}
          </p>
        ) : null}

        <ModalActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy} className="min-w-0 break-all">
            {busy ? "Création…" : createLabel}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
