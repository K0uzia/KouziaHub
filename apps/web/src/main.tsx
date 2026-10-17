import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <Toaster
          richColors
          // Centré en haut, sous la barre : loin des onglets du bas et des actions des modales sur mobile.
          position="top-center"
          theme="dark"
          offset={{ top: "calc(var(--topbar-h) + 1rem)" }}
          mobileOffset={{ top: "calc(var(--topbar-h) + 1rem)" }}
          toastOptions={{ className: "max-w-[calc(100vw-2rem)]" }}
        />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
