// Récupération (téléphone perdu, plus de code de secours) : 2FA coupée, sessions fermées.
// Lancer ensuite « hubctl admin » pour la réactiver avec le nouveau téléphone.
import { prisma } from "@/lib/prisma.js";
import { resetTwoFactor } from "@/lib/admin/two-factor.js";

async function main() {
  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) throw new Error("Aucun compte : lancez « hubctl admin ».");
  await resetTwoFactor(user.id);
  console.log("Double authentification coupée et sessions fermées. Relancez « hubctl admin » pour la réactiver.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
