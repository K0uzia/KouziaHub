// Import relatif : module aussi utilisé par l'interface (alias @hub/version-check), avant l'envoi.
import type { VersionCheck } from "../contract.js";

// Contrôle d'une version avant publication : un site statique a son index.html à la racine. Sinon, si les
// fichiers sont les sources d'un projet à construire (Astro, Vite, Next...), le hub le reconnaît et dit quoi
// lancer sur le PC. Le hub ne construit jamais rien (cadrage, section 2) : aucune commande n'est exécutée ici.

type Framework = {
  name: string;
  /** Fichier de configuration à la racine qui signe le framework. */
  config: RegExp;
  /** Dossier de sortie de la construction, dans l'ordre de préférence. */
  outDirs: string[];
  /** Commande sans script « build » dans package.json (ou hors Node). */
  command: string;
  /** Précision ajoutée à la commande (réglage indispensable pour un site statique). */
  note?: string;
  /** Script de package.json à préférer à « build » (Nuxt : « generate » produit le site statique). */
  script?: string;
};

const JS = "(?:js|cjs|mjs|ts|cts|mts)";
// Ordre : un projet Astro ou SvelteKit peut aussi avoir un vite.config ; Vite vient donc après eux.
const FRAMEWORKS: Framework[] = [
  { name: "Astro", config: new RegExp(`^astro\\.config\\.${JS}$`), outDirs: ["dist"], command: "npx astro build" },
  { name: "Next.js", config: new RegExp(`^next\\.config\\.${JS}$`), outDirs: ["out"], command: "npx next build", note: ' (avec output: "export" dans next.config)' },
  { name: "Nuxt", config: new RegExp(`^nuxt\\.config\\.${JS}$`), outDirs: [".output/public", "dist"], command: "npx nuxi generate", script: "generate" },
  { name: "SvelteKit", config: new RegExp(`^svelte\\.config\\.${JS}$`), outDirs: ["build"], command: "npx vite build" },
  { name: "Gatsby", config: new RegExp(`^gatsby-config\\.${JS}$`), outDirs: ["public"], command: "npx gatsby build" },
  { name: "Eleventy", config: new RegExp(`^(?:\\.eleventy\\.${JS}|eleventy\\.config\\.${JS})$`), outDirs: ["_site"], command: "npx @11ty/eleventy" },
  { name: "Vite", config: new RegExp(`^vite\\.config\\.${JS}$`), outDirs: ["dist"], command: "npx vite build" },
  { name: "Hugo", config: /^hugo\.(?:toml|ya?ml|json)$/, outDirs: ["public"], command: "hugo" },
  { name: "Jekyll", config: /^_config\.ya?ml$/, outDirs: ["_site"], command: "bundle exec jekyll build" },
];

/** Dossiers de sortie cherchés quand le framework est inconnu (public/ n'en fait pas partie : dossier source d'Astro, Vite...). */
const GENERIC_OUT_DIRS = ["dist", "build", "out", "_site", ".output/public"];

type PackageJson = { scripts?: Record<string, unknown> };

function parsePackageJson(text: string | null): PackageJson | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as PackageJson) : null;
  } catch {
    return null;
  }
}

/** Gestionnaire de paquets d'après le fichier de verrouillage présent à la racine. */
function runScript(root: Set<string>, script: string): string {
  if (root.has("pnpm-lock.yaml")) return `pnpm run ${script}`;
  if (root.has("yarn.lock")) return `yarn ${script}`;
  if (root.has("bun.lock") || root.has("bun.lockb")) return `bun run ${script}`;
  return `npm run ${script}`;
}

function detectFramework(paths: string[], root: Set<string>): Framework | null {
  for (const fw of FRAMEWORKS) {
    if ([...root].some((name) => fw.config.test(name))) return fw;
  }
  // Hugo ancien : config.toml (ou .yaml) à la racine avec un dossier content/.
  if ((root.has("config.toml") || root.has("config.yaml") || root.has("config.yml")) && paths.some((p) => p.startsWith("content/"))) {
    return FRAMEWORKS.find((f) => f.name === "Hugo")!;
  }
  return null;
}

/**
 * Contrôle de la version : null si index.html est à la racine sans fichier de configuration de framework (ou s'il
 * n'y a aucun fichier). Un fichier de configuration à la racine l'emporte : les sources de Vite et de Jekyll ont
 * leur propre index.html à la racine, qui n'est pas la page construite.
 * - output_folder : le site construit est dans un sous-dossier (dist/index.html), envoyé avec tout le projet ;
 * - unbuilt : sources d'un projet à construire, sans sortie construite ;
 * - no_index : ni index.html à la racine, ni projet reconnu.
 */
export function checkVersion(paths: string[], packageJsonText: string | null): VersionCheck | null {
  if (paths.length === 0) return null;
  const root = new Set(paths.filter((p) => !p.includes("/")));
  const framework = detectFramework(paths, root);
  if (!framework && root.has("index.html")) return null;
  const pkg = parsePackageJson(root.has("package.json") ? packageJsonText : null);
  const scripts = pkg?.scripts ?? {};
  const scriptName = framework?.script && typeof scripts[framework.script] === "string" ? framework.script : typeof scripts.build === "string" ? "build" : null;
  const buildScript = scriptName ? String(scripts[scriptName]).trim().slice(0, 120) : null;

  const outDirs = framework ? framework.outDirs : GENERIC_OUT_DIRS;
  const built = outDirs.find((d) => paths.includes(`${d}/index.html`));
  const label = framework ? `Projet ${framework.name}` : "Projet";

  if (built) {
    return {
      code: "output_folder",
      framework: framework?.name ?? null,
      command: null,
      outDir: `${built}/`,
      buildScript,
      message: `${label} envoyé en entier : le site construit est dans ${built}/. Envoyez seulement le contenu du dossier ${built}/ (index.html à la racine).`,
    };
  }
  if (framework || buildScript) {
    const command = scriptName ? runScript(root, scriptName) : framework!.command;
    const outDir = framework ? `${framework.outDirs[0]}/` : "dist/";
    const where = framework ? `le dossier ${outDir}` : `le dossier de sortie (souvent ${outDir})`;
    return {
      code: "unbuilt",
      framework: framework?.name ?? null,
      command,
      outDir,
      buildScript,
      message: `${label} non construit : lancez ${command} sur votre PC${framework?.note ?? ""}, puis envoyez ${where}.`,
    };
  }
  return {
    code: "no_index",
    framework: null,
    command: null,
    outDir: null,
    buildScript: null,
    message: "Pas de fichier index.html à la racine : le site n'aura pas de page d'accueil.",
  };
}
