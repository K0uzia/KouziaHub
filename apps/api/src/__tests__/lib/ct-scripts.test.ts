import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";

// Scripts des CT Alpine : un fichier n'est posé que dans un dossier créé par le script (mkdir -p) ou fourni par
// un paquet qu'il installe. L'Alpine minimale n'a pas /usr/local/sbin (recette du CT PHP, 25/10/2026).
const ROOT = join(import.meta.dirname, "../../../../../scripts");
// Dossiers garantis : OpenRC (base d'Alpine) et paquets installés avant toute écriture.
const PROVIDED = new Set(["/etc/init.d", "/etc/conf.d", "/etc", "/etc/nginx/http.d", "/etc/my.cnf.d", "/etc/php${_v}/conf.d", "/etc/php${_v}/php-fpm.d"]);

function shellFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "agent" || name === "recette" || name === "conf" ? [] : shellFiles(p);
    return readFileSync(p, "utf8").startsWith("#!/sbin/openrc-run") ? [] : [p];
  });
}

const unquote = (s: string) => s.replace(/^"|"$/g, "");

/** Destinations d'écriture (ln -s, install, cat >), avec le dossier qui doit exister. */
function destinations(text: string): Array<{ line: number; dest: string; dir: string }> {
  const out: Array<{ line: number; dest: string; dir: string }> = [];
  const lines = text.split("\n");
  // Variable locale (_x="...", ou "$(mktemp chemin)") : remplacée par sa dernière valeur avant l'écriture.
  const local = (name: string, before: number) => {
    const set = lines.slice(0, before).reverse().map((l) => new RegExp(`^\\s*${name}="(.*)"$`).exec(l)).find(Boolean);
    return set ? set[1]!.replace(/^\$\(mktemp (\S+)\)$/, "$1") : null;
  };
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (l.startsWith("#")) return;
    const m = /^(?:ln -sfn?|install(?: -[ogm] \S+)*) \S+ (\S+)$/.exec(l) ?? /^cat > (\S+) <</.exec(l);
    if (!m) return;
    let dest = unquote(m[1]!);
    const loc = /^\$\{?(_\w+)\}?$/.exec(dest);
    if (loc) dest = local(loc[1]!, i) ?? dest;
    if (!dest.startsWith("/") && !dest.startsWith("$")) return;
    const v = /^\$\{?(\w+)\}?$/.exec(dest);
    out.push({ line: i + 1, dest, dir: v ? `dirname:${v[1]}` : posix.dirname(dest) });
  });
  return out;
}

/** Dossier créé plus haut par mkdir -p (littéral, variable, ou $(dirname "$VAR")). */
function created(text: string, before: number, dir: string): boolean {
  const lines = text.split("\n").slice(0, before - 1).filter((l) => /^\s*mkdir -p /.test(l));
  if (dir.startsWith("dirname:")) {
    const v = dir.slice(8);
    return lines.some((l) => l.includes(`$(dirname "$${v}")`) || l.includes(`$(dirname "\${${v}}")`));
  }
  const forms = [dir, `"${dir}"`];
  const asVar = /^\$\{(\w+)\}$/.exec(dir);
  if (asVar) forms.push(`"$${asVar[1]}"`, `$${asVar[1]}`);
  return lines.some((l) => l.split(/\s+/).slice(2).some((w) => forms.includes(w)));
}

describe("scripts des CT Alpine : dossiers de destination", () => {
  const files = [...shellFiles(join(ROOT, "php-ct")), ...shellFiles(join(ROOT, "alpine"))];

  it("trouve des écritures à contrôler (le test lit bien les scripts)", () => {
    const all = files.flatMap((f) => destinations(readFileSync(f, "utf8")).map((d) => d.dest));
    expect(all).toEqual(expect.arrayContaining(["/usr/local/sbin/kouziaphpctl", "/usr/local/bin/hubctl", "$KP_CLOUDFLARED_BIN", "/etc/periodic/daily/kouziahub-backup"]));
  });

  it("chaque fichier posé l'est dans un dossier créé avant ou fourni par un paquet", () => {
    const missing = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return destinations(text)
        .filter((d) => !PROVIDED.has(d.dir) && !created(text, d.line, d.dir))
        .map((d) => `${f.slice(ROOT.length + 1).replace(/\\/g, "/")}:${d.line} ${d.dest}`);
    });
    expect(missing).toEqual([]);
  });
});

// Sous set -e, une fonction dont la dernière commande est « [ test ] && action » renvoie 1 quand le test est
// faux : appelée dans « x="$(f)" », elle arrête le script (status.sh coupé après la ligne Alpine, 25/10/2026).
// pct exec (lxc-attach) garde un PATH minimal, sans /usr/local/sbin ni /usr/local/bin : un outil que les scripts
// y posent s'appelle par son chemin complet (recette du 25/10/2026, 11.8 : « Failed to exec "kouziaphpctl" »).
describe("README : commandes pct exec", () => {
  it("les outils posés dans /usr/local par les scripts sont appelés par leur chemin complet", () => {
    const files = [...shellFiles(join(ROOT, "php-ct")), ...shellFiles(join(ROOT, "alpine"))];
    const tools = new Set(files.flatMap((f) => destinations(readFileSync(f, "utf8")).map((d) => d.dest)).filter((d) => d.startsWith("/usr/local/")).map((d) => posix.basename(d)));
    expect([...tools]).toEqual(expect.arrayContaining(["hubctl", "kouziaphpctl"]));
    const readme = readFileSync(join(ROOT, "../README.md"), "utf8");
    const bare = readme
      .split("\n")
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /pct exec /.test(l) && [...tools].some((t) => new RegExp(`(^|[^/\\w-])${t}\\b`).test(l.slice(l.indexOf("pct exec ")))))
      .map(({ l, n }) => `README.md:${n} ${l.trim()}`);
    expect(bare).toEqual([]);
  });
});

// Pare-feu du CT PHP : chargé par son service OpenRC (état connu d'OpenRC, relancé au démarrage), jamais par le
// service « nftables » d'Alpine dont le fichier par défaut vide tout (flush ruleset) et refuse toute entrée.
describe("CT PHP : pare-feu", () => {
  const all = [...shellFiles(join(ROOT, "php-ct")), join(ROOT, "php-ct/openrc/kouziaphp-firewall")];
  const text = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("la table n'est chargée que par le service kouziaphp-firewall", () => {
    const direct = all.filter((f) => !f.endsWith("kouziaphp-firewall") && /\bnft -f\b/.test(text(f)));
    expect(direct).toEqual([]);
    expect(text(join(ROOT, "php-ct/firewall.sh"))).toMatch(/rc-update add "\$KP_FIREWALL_SERVICE" default[\s\S]*rc_service "\$KP_FIREWALL_SERVICE" "\$_action"/);
  });

  it("ni flush ruleset ni service nftables d'Alpine", () => {
    const risky = all.filter((f) => /flush ruleset|rc-update add nftables|rc-service nftables/.test(text(f)));
    expect(risky).toEqual([]);
  });
});

describe("scripts des CT Alpine : fonctions sûres sous set -e", () => {
  const files = [...shellFiles(join(ROOT, "php-ct")), ...shellFiles(join(ROOT, "alpine"))];

  /** Dernière commande de chaque fonction (y compris celle de sa dernière boucle). */
  function lastCommands(text: string): Array<{ fn: string; line: number; cmd: string }> {
    const out: Array<{ fn: string; line: number; cmd: string }> = [];
    const lines = text.split("\n");
    let fn: string | null = null;
    lines.forEach((raw, i) => {
      const open = /^([a-z_]\w*)\(\) \{\s*$/.exec(raw);
      if (open) fn = open[1]!;
      else if (fn && raw === "}") {
        const body = lines.slice(0, i).map((l, n) => ({ l: l.trim(), n })).filter((x) => x.l && !x.l.startsWith("#")).reverse();
        const [last, before] = body;
        const target = last?.l === "done" && before ? before : last;
        if (target) out.push({ fn, line: target.n + 1, cmd: target.l });
        fn = null;
      }
    });
    return out;
  }

  it("aucune fonction ne finit sur « [ test ] && action »", () => {
    const risky = files.flatMap((f) =>
      lastCommands(readFileSync(f, "utf8"))
        .filter((c) => /^(\[|test )[^|]*&& /.test(c.cmd))
        .map((c) => `${f.slice(ROOT.length + 1).replace(/\\/g, "/")}:${c.line} ${c.fn}`),
    );
    expect(risky).toEqual([]);
  });

  const shAvailable = spawnSync("sh", ["-c", "exit 0"]).status === 0;
  it.runIf(shAvailable)("status.sh va jusqu'au bout sans Alpine ni PHP (binaires absents)", () => {
    const run = spawnSync("sh", [join(ROOT, "php-ct/status.sh")], { encoding: "utf8", env: { ...process.env, KP_SITES_DIR: mkdtempSync(join(tmpdir(), "kouzia-ct-")) } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("PHP installés          : aucun");
    expect(run.stdout).toContain("== Sécurité ==");
  });
});
