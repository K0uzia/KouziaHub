import type { VersionCheck } from "@hub/contract";
import { Banner } from "@/components/ui/Banner";

const TITLE: Record<VersionCheck["code"], string> = {
  unbuilt: "Ce n'est pas encore un site : ce sont les sources du projet.",
  output_folder: "Le site construit est dans un sous-dossier.",
  no_index: "Pas de page d'accueil.",
};

/**
 * Contrôle de la version de travail, montré dès l'envoi et tant qu'il tient : projet non construit (commande à
 * lancer sur le PC, dossier à envoyer), site construit envoyé avec ses sources, ou index.html absent. Le hub ne
 * construit rien lui-même.
 */
export function VersionCheckNotice({ check, id }: { check: VersionCheck; id?: string }) {
  return (
    <Banner level="warning" role="status" id={id}>
      <p className="font-medium">{TITLE[check.code]}</p>
      <p className="mt-1">{check.message}</p>
      {check.command ? (
        <p className="mt-2">
          Commande à lancer dans le dossier du projet : <code className="font-mono break-all">{check.command}</code>
          {check.buildScript ? (
            <span className="text-[var(--muted)]">
              {" "}
              (script build de package.json : <code className="font-mono break-all">{check.buildScript}</code>)
            </span>
          ) : null}
        </p>
      ) : null}
      {check.code !== "no_index" ? (
        <p className="mt-2 text-[var(--muted)]">Le hub ne construit rien : la construction se fait sur votre PC, puis seul le résultat est envoyé.</p>
      ) : null}
    </Banner>
  );
}
