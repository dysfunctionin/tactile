import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "../ui/styles/fonts.css";
import "../ui/styles/styles.css";
import { StartupLoader } from "../ui/components/StartupLoader.jsx";
import { ObjectPluginProvider } from "../ui/objects/registry/ObjectPluginProvider.jsx";
import {
  cacheThemePreference,
  loadThemePreference,
} from "../platform/browser/themePreference.js";
import {
  loadNativeThemePreference,
  saveNativeThemePreference,
} from "../platform/tauri/preferences.ts";

const nativeStartup = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
let startupTheme = nativeStartup ? "dark" : "light";
let startupDuration = nativeStartup ? 3000 : 1000;
let themePreference = loadThemePreference();
if (themePreference) startupTheme = themePreference.colorScheme;
try {
  const cached = JSON.parse(window.localStorage.getItem("tactile.workspace.v3") || "null");
  if (!themePreference && nativeStartup && cached?.activeThemeId === "paper-public") startupTheme = "light";
  if (nativeStartup && cached?.settings?.nativeWorkspacePath) startupDuration = 1000;
} catch {
  // The dark native startup surface remains the safe fallback.
}
document.documentElement.dataset.startupTheme = startupTheme;
delete document.documentElement.dataset.startupReady;

const App = lazy(() => import("./App.jsx").then(({ App: Component }) => ({ default: Component })));

async function start() {
  if (nativeStartup) {
    try {
      const nativePreference = await loadNativeThemePreference();
      if (nativePreference) {
        themePreference = cacheThemePreference(nativePreference);
      } else if (themePreference) {
        await saveNativeThemePreference(themePreference);
      }
      if (themePreference) document.documentElement.dataset.startupTheme = themePreference.colorScheme;
    } catch {
      // Keep the synchronized first-paint cache when the native profile is unavailable.
    }
  }

  createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <ObjectPluginProvider>
        <StartupLoader holdUntilReady minimumDuration={startupDuration} />
        <Suspense fallback={null}><App /></Suspense>
      </ObjectPluginProvider>
    </React.StrictMode>,
  );
}

void start();
