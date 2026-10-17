import { PageHeader, Card, EmptyState } from "@/components/ui/Card";
import { ButtonLink } from "@/components/ui/Button";
import { useTitle } from "@/lib/useTitle";

export function NotFoundPage() {
  useTitle("Page introuvable");
  return (
    <>
      <PageHeader title="Page introuvable" />
      <Card>
        <EmptyState
          title="Cette adresse ne mène à aucun écran du hub."
          action={<ButtonLink to="/">Retour aux sites</ButtonLink>}
        />
      </Card>
    </>
  );
}
