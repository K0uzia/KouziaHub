import { toast } from "sonner";

/** Copie dans le presse-papiers, avec un retour visible (succès ou échec). */
export async function copyText(text: string, done = "Copié"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Copie impossible : sélectionnez le texte et copiez-le à la main.");
  }
}
