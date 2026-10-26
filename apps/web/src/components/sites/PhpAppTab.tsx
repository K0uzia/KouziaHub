import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload, faEye, faEyeSlash, faPlay, faPlus, faTrashCan, faUpload } from "@fortawesome/free-solid-svg-icons";
import {
  PHP_LIMITS,
  type PhpCronEvery,
  type PhpCronView,
  type PhpDbView,
  type PhpEnvVar,
  type PhpEnvView,
  type PhpLogKind,
  type PhpLogView,
  type PhpScriptRun,
  type PhpScriptsView,
  type PhpServerStatus,
  type SiteDetail,
  type UpdatePhpSettingsInput,
} from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime, formatDay } from "@/lib/format";
import { envDirty, envPayload, LIVE_KEY_RE, memoryWarning, siteMemoryMb, type EnvRow } from "@/lib/phpApp";
import { useResource } from "@/lib/useResource";
import { Banner } from "@/components/ui/Banner";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";

// Onglet « Application » d'un site PHP (docs/cadrage.md, 11.5, lot P4) : réglages de PHP, variables, base, scripts.

type DbWithNightly = PhpDbView & { nightly: Array<{ day: string; bytes: number }> };
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

export function PhpAppTab({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  return (
    <div className="space-y-4">
      <PhpSettingsCard site={site} onSite={onSite} />
      <EnvCard site={site} />
      <DatabaseCard site={site} />
      <CronCard site={site} onSite={onSite} />
      <ScriptsCard site={site} />
      <LogsCard site={site} />
    </div>
  );
}

// --- Réglages de PHP ---

function PhpSettingsCard({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const php = site.php!;
  const server = useResource<PhpServerStatus>("/api/php/serveur");
  const versions = server.data?.configured && server.data.reachable ? server.data.state.php : [php.version];
  const [form, setForm] = useState(() => toForm(php));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = toForm(php);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const warning = memoryWarning(server.data);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const body: UpdatePhpSettingsInput = {
      version: form.version,
      publicDir: form.publicDir.trim().replace(/^\/+|\/+$/g, ""),
      persistentDirs: lines(form.persistentDirs),
      publicPersistentDirs: lines(form.publicPersistentDirs),
      memoryLimitMb: Number(form.memoryLimitMb),
      uploadMaxMb: Number(form.uploadMaxMb),
      maxExecutionSec: Number(form.maxExecutionSec),
      excludedPaths: lines(form.excludedPaths),
    };
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/php`, { method: "PATCH", json: body });
      onSite(updated);
      setForm(toForm(updated.php!));
      void server.reload();
      toast.success("Réglages de PHP posés sur le serveur");
    } catch (err) {
      setError(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Réglages de PHP</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Posés aussitôt sur le serveur des sites PHP ; PHP redémarre si ses limites changent.</p>
      {warning ? (
        <Banner level="warning" className="mt-3">
          {warning}
        </Banner>
      ) : null}
      <form onSubmit={onSave} noValidate className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Version de PHP">
            <Select value={form.version} onChange={set("version")}>
              {[...new Set([...versions, php.version])].map((v) => (
                <option key={v} value={v}>
                  PHP {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dossier public" hint="Seul dossier servi (vide : racine du projet).">
            <Input value={form.publicDir} onChange={set("publicDir")} autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <Field label="Dossiers persistants" hint="Un par ligne, hors du dossier public, jamais servis : données, clés (ex. data).">
            <Textarea value={form.persistentDirs} onChange={set("persistentDirs")} rows={2} autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <Field
            label="Dossiers persistants publics"
            hint="Un par ligne, dans le dossier public : fichiers envoyés par le site, servis tels quels, jamais exécutés (ex. public/assets/img/oeuvres)."
          >
            <Textarea value={form.publicPersistentDirs} onChange={set("publicPersistentDirs")} rows={2} autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
        </div>
        <Field
          label="Ne pas envoyer"
          hint="Un par ligne : dossier terminé par / (ex. src/produit/) ou fichier exact. Refusés à l'envoi avec la raison, retirés des fichiers de travail du hub à l'enregistrement (jamais de votre ordinateur)."
        >
          <Textarea value={form.excludedPaths} onChange={set("excludedPaths")} rows={2} autoComplete="off" spellCheck={false} className="font-mono" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Mémoire par requête (Mo)"
            hint={`${PHP_LIMITS.memoryLimitMb.min} à ${PHP_LIMITS.memoryLimitMb.max}. Plafond du site : ${siteMemoryMb(Number(form.memoryLimitMb) || 0)} Mo.`}
          >
            <Input type="number" inputMode="numeric" min={PHP_LIMITS.memoryLimitMb.min} max={PHP_LIMITS.memoryLimitMb.max} value={form.memoryLimitMb} onChange={set("memoryLimitMb")} />
          </Field>
          <Field label="Taille d'envoi (Mo)" hint={`${PHP_LIMITS.uploadMaxMb.min} à ${PHP_LIMITS.uploadMaxMb.max}. Requête entière : le double, 256 Mo au plus.`}>
            <Input type="number" inputMode="numeric" min={PHP_LIMITS.uploadMaxMb.min} max={PHP_LIMITS.uploadMaxMb.max} value={form.uploadMaxMb} onChange={set("uploadMaxMb")} />
          </Field>
          <Field label="Durée d'une requête (s)" hint={`${PHP_LIMITS.maxExecutionSec.min} à ${PHP_LIMITS.maxExecutionSec.max}.`}>
            <Input type="number" inputMode="numeric" min={PHP_LIMITS.maxExecutionSec.min} max={PHP_LIMITS.maxExecutionSec.max} value={form.maxExecutionSec} onChange={set("maxExecutionSec")} />
          </Field>
        </div>
        {error ? (
          <Banner level="error" role="alert">
            {error}
          </Banner>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function toForm(php: NonNullable<SiteDetail["php"]>) {
  return {
    version: php.version,
    publicDir: php.publicDir,
    persistentDirs: php.persistentDirs.join("\n"),
    publicPersistentDirs: php.publicPersistentDirs.join("\n"),
    memoryLimitMb: String(php.memoryLimitMb),
    uploadMaxMb: String(php.uploadMaxMb),
    maxExecutionSec: String(php.maxExecutionSec),
    excludedPaths: php.excludedPaths.join("\n"),
  };
}

// --- Variables ---

function EnvCard({ site }: { site: SiteDetail }) {
  const env = useResource<PhpEnvView>(`/api/sites/${site.id}/php/variables`);
  const nextKey = useRef(0);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toRows = (vars: PhpEnvVar[]) => vars.map((v) => ({ key: nextKey.current++, name: v.name, value: v.value }));
  useEffect(() => {
    if (env.data) setRows(toRows(env.data.vars));
  }, [env.data]);

  const live = rows.find((r) => LIVE_KEY_RE.test(r.value));
  const dirty = env.data ? envDirty(rows, env.data.vars) : false;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const saved = await api<PhpEnvView>(`/api/sites/${site.id}/php/variables`, { method: "PUT", json: { vars: envPayload(rows) } });
      env.setData(saved);
      setShown(new Set());
      toast.success("Variables enregistrées : le .env du site est réécrit");
    } catch (err) {
      setError(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  const update = (key: number, patch: Partial<EnvRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const toggle = (key: number) => setShown((s) => new Set(s.has(key) ? [...s].filter((k) => k !== key) : [...s, key]));
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Variables d'environnement</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Écrites dans le .env du site, à la racine du projet, hors du dossier public. Chiffrées dans le hub. Clés de paiement réelles (live) refusées.
      </p>
      {env.error ? (
        <Banner level="error" className="mt-3">
          {env.error}
        </Banner>
      ) : null}
      {env.data ? (
        <form onSubmit={onSave} noValidate className="mt-4 space-y-3">
          {rows.length ? (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.key} className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
                  <Input
                    aria-label="Nom de la variable"
                    value={r.name}
                    onChange={(e) => update(r.key, { name: e.target.value })}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="font-mono"
                    placeholder="NOM"
                  />
                  <Input
                    aria-label={`Valeur de ${r.name || "la variable"}`}
                    type={shown.has(r.key) ? "text" : "password"}
                    value={r.value}
                    onChange={(e) => update(r.key, { value: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" onClick={() => toggle(r.key)} aria-label={shown.has(r.key) ? `Masquer ${r.name}` : `Afficher ${r.name}`}>
                      <FontAwesomeIcon icon={shown.has(r.key) ? faEyeSlash : faEye} className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button type="button" variant="danger-ghost" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Retirer ${r.name || "la ligne"}`}>
                      <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--muted)]">Aucune variable.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, name: "", value: "" }])}>
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
              Ajouter une variable
            </Button>
            {env.data.suggestions
              .filter((s) => !rows.some((r) => r.name.trim().toUpperCase() === s.name))
              .map((s) => (
                <Button key={s.name} type="button" variant="ghost" title={s.why} onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, name: s.name, value: s.value }])}>
                  <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
                  {s.name}
                </Button>
              ))}
          </div>
          {live ? (
            <Banner level="warning">{live.name || "Une variable"} contient une clé de paiement réelle (live) : elle sera refusée. Mettre la clé de test.</Banner>
          ) : null}
          {error ? (
            <Banner level="error" role="alert">
              {error}
            </Banner>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? "Enregistrement…" : "Enregistrer les variables"}
            </Button>
          </div>
          {env.data.db ? (
            <div className="border-t border-[var(--border)] pt-3">
              <h3 className="text-sm font-semibold">Base du site (remplies d'office)</h3>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                {env.data.db.map((v) => (
                  <div key={v.name} className="contents">
                    <dt className="font-mono text-[var(--muted)]">{v.name}</dt>
                    <dd className="min-w-0 break-all font-mono">{v.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </form>
      ) : env.error ? null : (
        <p className="mt-4 text-sm text-[var(--muted)]">Lecture…</p>
      )}
    </Card>
  );
}

// --- Base de données ---

type Pending = { kind: "reset" } | { kind: "dump"; version: number } | { kind: "nightly"; day: string } | null;

function DatabaseCard({ site }: { site: SiteDetail }) {
  const db = useResource<DbWithNightly>(`/api/sites/${site.id}/php/base`);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [typed, setTyped] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirmId = useId();

  async function act(label: string, run: () => Promise<PhpDbView>, done: string) {
    setBusy(label);
    try {
      const state = await run();
      db.setData({ ...state, nightly: db.data?.nightly ?? [] });
      toast.success(done);
      void db.reload();
    } catch (err) {
      toast.error(errorMessage(err, "Opération impossible."));
    } finally {
      setBusy(null);
      setPending(null);
      setTyped("");
    }
  }

  const create = () => act("create", () => api<PhpDbView>(`/api/sites/${site.id}/php/base`, { method: "POST" }), "Base créée : DB_* ajoutées au .env");
  const runImport = (file: File) =>
    act(
      "import",
      () =>
        api<PhpDbView>(`/api/sites/${site.id}/php/base/import`, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.name.endsWith(".gz") ? "application/gzip" : "application/sql" },
        }),
      `${file.name} importé`,
    );
  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === "reset") void act("reset", () => api<PhpDbView>(`/api/sites/${site.id}/php/base/reinitialiser`, { method: "POST", json: { confirm: typed } }), "Base vidée");
    else if (pending.kind === "dump")
      void act("restore", () => api<PhpDbView>(`/api/sites/${site.id}/php/base/restaurer`, { method: "POST", json: { version: pending.version, confirm: typed } }), `Base remise comme avant la version ${pending.version}`);
    else
      void act("restore", () => api<PhpDbView>(`/api/sites/${site.id}/php/base/sauvegarde`, { method: "POST", json: { day: pending.day, confirm: typed } }), `Base remise comme le ${formatDay(pending.day)}`);
  };

  const d = db.data;
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Base de données</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">MariaDB sur le serveur des sites PHP, par le socket local seulement. Dump pris avant chaque publication ; sauvegarde chaque nuit dans le hub, 14 jours.</p>
      {db.error ? (
        <Banner level="error" className="mt-3">
          {db.error}
        </Banner>
      ) : null}
      {d && !d.exists ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm">Pas encore de base pour ce site.</p>
          <Button onClick={() => void create()} disabled={busy !== null}>
            {busy === "create" ? "Création…" : "Créer la base"}
          </Button>
          {d.nightly.length ? <NightlyList nightly={d.nightly} onRestore={(day) => setPending({ kind: "nightly", day })} disabled={busy !== null} /> : null}
        </div>
      ) : null}
      {d?.exists ? (
        <div className="mt-4 space-y-4">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
            <dt className="text-[var(--muted)]">Base</dt>
            <dd className="font-mono">{d.name}</dd>
            <dt className="text-[var(--muted)]">Taille</dt>
            <dd>
              {formatBytes(d.bytes)}, {d.tables} table{d.tables > 1 ? "s" : ""}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/sites/${site.id}/php/base/export`} download className={buttonClass("secondary")}>
              <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" aria-hidden />
              Exporter (.sql.gz)
            </a>
            <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
              <FontAwesomeIcon icon={faUpload} className="h-3.5 w-3.5" aria-hidden />
              {busy === "import" ? "Import…" : "Importer un fichier SQL"}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".sql,.gz,application/sql,application/gzip"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (f) setImportFile(f);
              }}
            />
            <Button variant="danger" onClick={() => setPending({ kind: "reset" })} disabled={busy !== null}>
              Réinitialiser
            </Button>
          </div>
          {d.dumps.length ? (
            <div>
              <h3 className="text-sm font-semibold">Dumps d'avant publication</h3>
              <ul className="mt-2 divide-y divide-[var(--border)] text-sm">
                {d.dumps.map((n) => (
                  <li key={n} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>Base telle qu'avant la version {n}</span>
                    <Button variant="ghost" onClick={() => setPending({ kind: "dump", version: n })} disabled={busy !== null}>
                      Restaurer
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {d.nightly.length ? <NightlyList nightly={d.nightly} onRestore={(day) => setPending({ kind: "nightly", day })} disabled={busy !== null} /> : null}
        </div>
      ) : null}
      {!d && !db.error ? <p className="mt-4 text-sm text-[var(--muted)]">Lecture…</p> : null}

      <ConfirmDialog
        open={importFile !== null}
        title="Importer dans la base"
        message={
          <>
            Le fichier <span className="font-mono">{importFile?.name}</span> ({formatBytes(importFile?.size ?? 0)}) est exécuté sur la base du site, avec son compte : il ne
            peut toucher que cette base. Exporter d'abord pour garder l'état actuel.
          </>
        }
        confirmLabel="Importer"
        busy={busy === "import"}
        onClose={() => setImportFile(null)}
        onConfirm={() => {
          const f = importFile;
          setImportFile(null);
          if (f) void runImport(f);
        }}
      />
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "reset" ? "Vider la base" : "Restaurer la base"}
        danger
        busy={busy === "reset" || busy === "restore"}
        confirmDisabled={typed.trim().toLowerCase() !== site.slug}
        confirmLabel={pending?.kind === "reset" ? "Vider la base" : "Restaurer"}
        message={
          pending?.kind === "reset"
            ? "Toutes les tables et données de la base sont supprimées. Le compte et les DB_* du .env restent."
            : "La base actuelle est vidée, puis remplacée par la copie choisie. Ce qui a été écrit depuis est perdu."
        }
        onClose={() => {
          setPending(null);
          setTyped("");
        }}
        onConfirm={confirmPending}
      >
        <Field label={`Pour confirmer, taper le sous-domaine « ${site.slug} »`} className="mt-4">
          <Input id={confirmId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </Field>
      </ConfirmDialog>
    </Card>
  );
}

function NightlyList({ nightly, onRestore, disabled }: { nightly: Array<{ day: string; bytes: number }>; onRestore: (day: string) => void; disabled: boolean }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">Sauvegardes de nuit (hub)</h3>
      <ul className="mt-2 divide-y divide-[var(--border)] text-sm">
        {nightly.map((n) => (
          <li key={n.day} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {formatDay(n.day)} <span className="text-[var(--muted)]">({formatBytes(n.bytes)})</span>
            </span>
            <Button variant="ghost" onClick={() => onRestore(n.day)} disabled={disabled}>
              Restaurer
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Scripts du projet ---

function ScriptsCard({ site }: { site: SiteDetail }) {
  const list = useResource<PhpScriptsView>(`/api/sites/${site.id}/php/scripts`);
  const [script, setScript] = useState("");
  const [args, setArgs] = useState("");
  const [stdin, setStdin] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PhpScriptRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = script || list.data?.scripts[0] || "";

  async function onRun(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setRunning(true);
    try {
      const r = await api<PhpScriptRun>(`/api/sites/${site.id}/php/script`, { method: "POST", json: { path: chosen, args: lines(args), stdin } });
      setResult(r);
    } catch (err) {
      setError(errorMessage(err, "Lancement impossible."));
    } finally {
      // L'entrée (un mot de passe, souvent) ne reste jamais à l'écran.
      setStdin("");
      setRunning(false);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Scripts du projet</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Script de la version servie, lancé sous le compte du site (migrations, création d'un compte...). 120 s au plus. Les arguments et l'entrée ne sont jamais journalisés.
      </p>
      {list.error ? (
        <Banner level="error" className="mt-3">
          {list.error}
        </Banner>
      ) : null}
      {list.data && !list.data.scripts.length ? <p className="mt-4 text-sm text-[var(--muted)]">Aucun script .php dans la version servie : publier le projet d'abord.</p> : null}
      {list.data?.scripts.length ? (
        <form onSubmit={onRun} noValidate className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Script" hint={list.data.publishedVersion ? `Version ${list.data.publishedVersion}.` : undefined}>
              <Select value={chosen} onChange={(e) => setScript(e.target.value)} className="font-mono">
                {list.data.scripts.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Arguments (facultatif)" hint="Un par ligne, 20 au plus.">
              <Textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={2} autoComplete="off" spellCheck={false} className="font-mono" />
            </Field>
            <Field label="Entrée standard (facultatif)" hint="Un mot de passe demandé par le script, par exemple : envoyé une fois, masqué dans la sortie." className="sm:col-span-2">
              <Input type="password" value={stdin} onChange={(e) => setStdin(e.target.value)} autoComplete="new-password" spellCheck={false} />
            </Field>
          </div>
          {error ? (
            <Banner level="error" role="alert">
              {error}
            </Banner>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={running || !chosen}>
              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" aria-hidden />
              {running ? "En cours…" : "Lancer"}
            </Button>
          </div>
        </form>
      ) : null}
      {result ? (
        <div className="mt-4 space-y-2" role="status">
          <p className="text-sm">
            <span className="font-mono">{result.script}</span> :{" "}
            {result.timedOut ? (
              <span className="text-[var(--danger)]">arrêté, délai dépassé</span>
            ) : result.code === 0 ? (
              <span className="text-[var(--success)]">terminé (code 0)</span>
            ) : (
              <span className="text-[var(--danger)]">échec (code {result.code})</span>
            )}
            , {Math.round(result.durationMs / 100) / 10} s
          </p>
          <pre tabIndex={0} aria-label="Sortie du script" className="code-block max-h-80 whitespace-pre-wrap">
            {result.output || "(aucune sortie)"}
          </pre>
        </div>
      ) : null}
    </Card>
  );
}

// --- Tâche planifiée (lot P5) ---

const EVERY_LABEL: Record<PhpCronEvery, string> = {
  "5m": "Toutes les 5 minutes",
  "15m": "Toutes les 15 minutes",
  "30m": "Toutes les 30 minutes",
  "1h": "Toutes les heures",
  "1d": "Chaque nuit (vers 3 h)",
};

function CronCard({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const state = useResource<PhpCronView>(`/api/sites/${site.id}/php/cron`);
  const scripts = useResource<PhpScriptsView>(`/api/sites/${site.id}/php/scripts`);
  const current = site.php!.cron;
  const [script, setScript] = useState(current?.script ?? "");
  const [every, setEvery] = useState<PhpCronEvery>(current?.every ?? "15m");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [...new Set([...(scripts.data?.scripts ?? []), ...(current ? [current.script] : [])])];
  const chosen = script || options[0] || "";

  async function save(cron: { script: string; every: PhpCronEvery } | null) {
    setSaving(true);
    setError(null);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/php`, { method: "PATCH", json: { cron } });
      onSite(updated);
      void state.reload();
      toast.success(cron ? "Tâche planifiée posée sur le serveur" : "Tâche planifiée retirée");
    } catch (err) {
      setError(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  const last = state.data?.last ?? null;
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Tâche planifiée</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Script de la version servie, lancé sous le compte du site, sans chevauchement et avec une durée maximale. Coupée quand le site est coupé.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({ script: chosen, every });
        }}
        noValidate
        className="mt-4 space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Script" hint={options.length ? undefined : "Aucun script .php dans la version servie : publier le projet d'abord."}>
            <Select value={chosen} onChange={(e) => setScript(e.target.value)} className="font-mono" disabled={!options.length}>
              {options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fréquence" hint={state.data?.maxSec ? `Durée maximale : ${Math.round(state.data.maxSec / 60)} min.` : undefined}>
            <Select value={every} onChange={(e) => setEvery(e.target.value as PhpCronEvery)}>
              {(Object.keys(EVERY_LABEL) as PhpCronEvery[]).map((k) => (
                <option key={k} value={k}>
                  {EVERY_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error ? (
          <Banner level="error" role="alert">
            {error}
          </Banner>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {current ? (
            <Button type="button" variant="secondary" onClick={() => void save(null)} disabled={saving}>
              Retirer la tâche
            </Button>
          ) : null}
          <Button type="submit" disabled={saving || !chosen}>
            {saving ? "Enregistrement…" : current ? "Enregistrer" : "Planifier"}
          </Button>
        </div>
      </form>
      {state.error ? (
        <Banner level="error" className="mt-3">
          {state.error}
        </Banner>
      ) : null}
      {current && state.data ? (
        <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3 text-sm">
          <p>
            {!state.data.active ? (
              <span className="text-[var(--warning)]">En pause : le site est coupé.</span>
            ) : last ? (
              <>
                Dernier passage le {formatDateTime(last.start)} :{" "}
                {last.skipped ? (
                  <span className="text-[var(--warning)]">sauté (le précédent tournait encore)</span>
                ) : last.timedOut ? (
                  <span className="text-[var(--danger)]">arrêté, durée maximale dépassée</span>
                ) : last.code === 0 ? (
                  <span className="text-[var(--success)]">terminé (code 0)</span>
                ) : (
                  <span className="text-[var(--danger)]">échec (code {last.code})</span>
                )}
                {last.skipped ? null : `, ${last.durationSec} s`}
              </>
            ) : (
              "Pas encore de passage."
            )}
          </p>
          {state.data.output ? (
            <pre tabIndex={0} aria-label="Sortie du dernier passage" className="code-block max-h-64 whitespace-pre-wrap">
              {state.data.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// --- Journaux du site (lot P5) ---

const LOG_LABEL: Record<PhpLogKind, string> = { php: "Erreurs PHP", fpm: "PHP-FPM", nginx: "Erreurs nginx", cron: "Tâche planifiée" };

function LogsCard({ site }: { site: SiteDetail }) {
  const [kind, setKind] = useState<PhpLogKind>("php");
  const log = useResource<PhpLogView>(`/api/sites/${site.id}/php/journaux/${kind}?lignes=200`);
  const download = () => {
    const url = URL.createObjectURL(new Blob([log.data?.text ?? ""], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${site.slug}-${kind}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Journaux</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Les 200 dernières lignes ; les valeurs du .env y sont masquées.</p>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label="Journal">
          <Select value={kind} onChange={(e) => setKind(e.target.value as PhpLogKind)}>
            {(Object.keys(LOG_LABEL) as PhpLogKind[]).map((k) => (
              <option key={k} value={k}>
                {LOG_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" onClick={() => void log.reload()} disabled={log.loading}>
          Actualiser
        </Button>
        <Button variant="ghost" onClick={download} disabled={!log.data?.text}>
          <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" aria-hidden />
          Télécharger
        </Button>
      </div>
      {log.error ? (
        <Banner level="error" className="mt-3">
          {log.error}
        </Banner>
      ) : null}
      <pre tabIndex={0} aria-label={`Journal : ${LOG_LABEL[kind]}`} className="code-block mt-3 max-h-96 whitespace-pre-wrap">
        {log.data ? log.data.text || "(vide)" : "Lecture…"}
      </pre>
    </Card>
  );
}
