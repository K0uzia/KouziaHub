import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faGear, faHeartPulse, faKey, faRightFromBracket, faTableCellsLarge } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/api";
import { onForegroundPush, pushToastKind } from "@/lib/push";
import { BrandMark } from "@/components/BrandMark";

type NavItem = { to: string; label: string; icon: IconDefinition; match: (path: string) => boolean };

const NAV: NavItem[] = [
  { to: "/", label: "Sites", icon: faTableCellsLarge, match: (p) => p === "/" || p.startsWith("/sites") },
  { to: "/surveillance", label: "Surveillance", icon: faHeartPulse, match: (p) => p.startsWith("/surveillance") },
  { to: "/logiciels", label: "Logiciels", icon: faKey, match: (p) => p.startsWith("/logiciels") },
  { to: "/reglages", label: "Réglages", icon: faGear, match: (p) => p.startsWith("/reglages") },
];

export function AppLayout() {
  const { logout, user } = useAuth();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();

  // Changement d'écran : la région qui défile revient en haut (sinon la fiche s'ouvrait au milieu).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  // Alerte reçue hub à l'écran : toast dans la page ; la notification de l'appareil reste pour le hub hors écran.
  useEffect(
    () =>
      onForegroundPush((push) => {
        toast[pushToastKind(push)](push.title, {
          description: push.body || undefined,
          id: push.tag || undefined,
          action: { label: "Ouvrir", onClick: () => navigate(push.url) },
        });
      }),
    [navigate],
  );

  async function onLogout() {
    try {
      await logout();
      toast.success("Déconnecté");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden">
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-[var(--radius-sm)] focus:bg-[var(--primary)] focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-[var(--primary-fg)]"
      >
        Aller au contenu
      </a>

      {/* Barre pleine largeur (filet), contenu calé sur la même colonne que les pages : marque et actions alignées sur le contenu. */}
      <header className="topbar custom-scrollbar z-30 shrink-0 border-b border-[var(--border)] bg-[var(--bg)] pt-[env(safe-area-inset-top)]">
        <div className="page-frame flex h-[var(--topbar-h)] min-w-0 items-center gap-2">
        <Link to="/" className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)]" aria-label="Kouzia Hub, catalogue des sites">
          <BrandMark className="h-8 w-8" />
          <span className="truncate font-display text-lg font-semibold tracking-wide text-[var(--text)]">
            Kouzia <span className="text-[var(--primary)]">Hub</span>
          </span>
        </Link>

        <nav aria-label="Navigation principale" className="ml-6 hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-3 text-sm transition-colors ${
                      active
                        ? "bg-[var(--primary-soft)] font-medium text-[var(--text)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    }`}
                  >
                    <FontAwesomeIcon
                      icon={item.icon}
                      className={`h-4 w-4 ${active ? "text-[var(--primary)]" : ""}`}
                      aria-hidden
                    />
                    {item.label}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {user ? (
            <span className="hidden max-w-[16rem] truncate text-sm text-[var(--muted)] lg:inline" title={user.email}>
              {user.name || user.email}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void onLogout()}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] px-2 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] sm:px-3"
          >
            <FontAwesomeIcon icon={faRightFromBracket} className="h-4 w-4" aria-hidden />
            <span className="sr-only sm:not-sr-only">Se déconnecter</span>
          </button>
        </div>
        </div>
      </header>

      {/* Région qui défile : atteignable au clavier, contour visible seulement au focus clavier. */}
      <main
        id="contenu"
        ref={mainRef}
        tabIndex={-1}
        className="custom-scrollbar main-scroll relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden focus:outline-none"
      >
        <div className="page-frame py-5 lg:py-7">
          <Outlet />
        </div>
      </main>

      <nav
        aria-label="Accès rapide"
        className="grid shrink-0 grid-cols-4 border-t border-[var(--border)] bg-[var(--bg-subtle)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-14 flex-col items-center justify-center gap-1 text-[length:var(--text-tab)] ${
                active ? "font-medium text-[var(--primary)]" : "text-[var(--muted)]"
              }`}
            >
              {active ? (
                <span className="absolute inset-x-1/4 top-0 h-0.5 rounded-full bg-[var(--primary)]" aria-hidden />
              ) : null}
              <FontAwesomeIcon icon={item.icon} className="h-4 w-4" aria-hidden />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
