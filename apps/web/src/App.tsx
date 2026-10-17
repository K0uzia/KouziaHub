import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { CatalogPage } from "@/pages/CatalogPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";

// Fiche et réglages chargés à la demande : le catalogue s'affiche sans eux.
const SitePage = lazy(() => import("@/pages/SitePage").then((m) => ({ default: m.SitePage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));

function Loading() {
  return (
    <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
      Chargement…
    </p>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, unreachable, refresh } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <main id="contenu" className="grid min-h-dvh place-items-center px-4">
        <Loading />
      </main>
    );
  }
  if (!user && unreachable) {
    return (
      <main id="contenu" className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-md space-y-4">
          <h1 className="text-lg font-semibold">Kouzia Hub</h1>
          <Banner level="error">Le hub ne répond pas. Vérifiez la connexion du téléphone ou de l'ordinateur.</Banner>
          <Button onClick={() => void refresh()}>Réessayer</Button>
        </div>
      </main>
    );
  }
  if (!user) return <Navigate to="/connexion" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/connexion" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<CatalogPage />} />
        <Route
          path="/sites/:id"
          element={
            <Suspense fallback={<Loading />}>
              <SitePage />
            </Suspense>
          }
        />
        <Route
          path="/reglages"
          element={
            <Suspense fallback={<Loading />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
