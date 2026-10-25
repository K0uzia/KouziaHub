import type { RunIo, RunResult, Sys } from "../../../../../scripts/php-ct/agent/sites.mjs";

// Système simulé pour les opérations de l'agent PHP : fichiers en mémoire, commandes enregistrées.
type Node = { type: "file"; text: string } | { type: "dir" } | { type: "link"; target: string };

/** Système simulé : fichiers en mémoire, commandes enregistrées (réponses choisies par le test). */
export function memorySys(answer: (file: string, args: string[]) => RunResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const nodes = new Map<string, Node>([["/etc/passwd", { type: "file", text: "root:x:0:0::/root:/bin/sh\nphp-autre:x:20000:20000::/srv/sites/autre:/sbin/nologin\n" }]]);
  const runs: string[] = [];
  const inputs: Array<{ file: string; args: string[]; input: string | null; io: RunIo }> = [];
  const owners = new Map<string, string>();
  const under = (p: string) => [...nodes.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
  const sys: Sys = {
    run: async (file, args) => {
      runs.push([file, ...args].join(" "));
      // Copie de côté d'une installation (« cp -a ») : simulée sur l'arbre en mémoire.
      if (file === "/bin/cp" && args[0] === "-a") {
        for (const k of under(args[1]!)) nodes.set(args[2]! + k.slice(args[1]!.length), nodes.get(k)!);
      }
      // Comme le vrai adduser : le compte du site apparaît dans /etc/passwd (UID, groupe de même numéro).
      if (file === "/usr/sbin/adduser") {
        const uid = args[args.indexOf("-u") + 1]!;
        const user = args.at(-1)!;
        const passwd = nodes.get("/etc/passwd");
        if (passwd?.type === "file" && !passwd.text.split("\n").some((l) => l.startsWith(`${user}:`))) {
          nodes.set("/etc/passwd", { type: "file", text: `${passwd.text}${user}:x:${uid}:${uid}::/srv/sites/${user.slice(4)}:/sbin/nologin\n` });
        }
      }
      return answer(file, args);
    },
    readFile: async (p) => {
      const n = nodes.get(p);
      if (n?.type !== "file") throw new Error(`absent : ${p}`);
      return n.text;
    },
    writeFile: async (p, text) => void nodes.set(p, { type: "file", text }),
    mkdir: async (p) => {
      const parts = p.split("/");
      for (let i = 2; i <= parts.length; i++) if (!nodes.has(parts.slice(0, i).join("/"))) nodes.set(parts.slice(0, i).join("/"), { type: "dir" });
    },
    rm: async (p) => {
      for (const k of under(p)) nodes.delete(k);
    },
    symlink: async (target, p) => void nodes.set(p, { type: "link", target }),
    rename: async (a, b) => {
      for (const k of under(b)) nodes.delete(k);
      for (const k of under(a)) {
        nodes.set(b + k.slice(a.length), nodes.get(k)!);
        nodes.delete(k);
      }
    },
    readdir: async (p) => [...new Set(under(p).filter((k) => k !== p).map((k) => k.slice(p.length + 1).split("/")[0]!))],
    chown: async (p, u, g) => void owners.set(p, `${u}:${g}`),
    exists: async (p) => nodes.has(p),
    cp: async (a, b) => {
      for (const k of under(a)) nodes.set(b + k.slice(a.length), nodes.get(k)!);
    },
    // Entrée et sortie en flux, simulées : l'entrée (texte ou fichier) est gardée pour le test ; une sortie vers un
    // fichier y écrit le stdout de la réponse choisie.
    runIo: async (file, args, io = {}) => {
      runs.push([file, ...args].join(" "));
      inputs.push({ file, args, input: io.input ?? (io.inputFile ? (nodes.get(io.inputFile) as { text?: string } | undefined)?.text ?? null : null), io });
      // Dossiers persistants : création et copie sans écraser, faites sous le compte du site (simulées ici).
      if (file === "/bin/mkdir" && args[0] === "-p") await sys.mkdir(args[1]!, 0o750);
      if (args[0] === "-e" && args[1]?.includes("cpSync")) {
        const [src, dst] = [args[2]!, args[3]!];
        for (const k of under(src)) {
          const target = dst + k.slice(src.length);
          if (!nodes.has(target)) nodes.set(target, nodes.get(k)!);
        }
      }
      const r = answer(file, args);
      if (io.outputFile && r.code === 0) nodes.set(io.outputFile, { type: "file", text: r.stdout });
      return io.outputFile ? { ...r, stdout: "" } : r;
    },
  };
  return { sys, nodes, runs, owners, inputs };
}

