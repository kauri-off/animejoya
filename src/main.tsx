import React from "react";
import ReactDOM from "react-dom/client";
import { Router } from "wouter";
import { navigate, useHashLocation } from "wouter/use-hash-location";
import { LucideProvider } from "lucide-react";
import App from "./App";
import "./styles.css";

// Старые адреса вида `#cache` и `#<ссылка на тайтл>` переводим в маршруты.
const migrate = () => {
  const legacy = location.hash.slice(1);
  if (legacy && !legacy.startsWith("/")) navigate(legacy === "cache" ? "/cache" : `/title/${legacy}`, { replace: true });
};
migrate();
addEventListener("hashchange", migrate);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router hook={useHashLocation}>
      <LucideProvider size={16} strokeWidth={1.9}>
        <App />
      </LucideProvider>
    </Router>
  </React.StrictMode>,
);
