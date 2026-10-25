import { readdirSync, readFileSync, statSync } from "node:fs";
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
