import { normalizeThemePreference } from "../../core/workspace/themePreference.js";
import { requireTauriInvoke, type TauriInvoke } from "./runtime.ts";

export type ThemePreference = {
  themeId: string;
  colorScheme: "dark" | "light";
  theme?: Record<string, unknown>;
};

export type RemovalMode = "preservePreferences" | "deleteEverything";

type AppPreferences = {
  version: number;
  theme?: unknown;
};

function invokeFor(explicitInvoke?: TauriInvoke): TauriInvoke {
  return requireTauriInvoke(undefined, explicitInvoke);
}

export async function loadNativeThemePreference(explicitInvoke?: TauriInvoke): Promise<ThemePreference | null> {
  const response = (await invokeFor(explicitInvoke)("preferences_load", {})) as AppPreferences | null;
  return normalizeThemePreference(response?.theme) as ThemePreference | null;
}

export async function saveNativeThemePreference(
  preference: ThemePreference,
  explicitInvoke?: TauriInvoke,
): Promise<ThemePreference> {
  const normalized = normalizeThemePreference(preference) as ThemePreference | null;
  if (!normalized) throw new TypeError("A valid theme preference is required.");
  const response = (await invokeFor(explicitInvoke)("preferences_save_theme", {
    preference: normalized,
  })) as AppPreferences;
  const saved = normalizeThemePreference(response?.theme) as ThemePreference | null;
  if (!saved) throw new TypeError("Native preferences returned an invalid theme.");
  return saved;
}

export async function prepareNativeRemoval(mode: RemovalMode, explicitInvoke?: TauriInvoke): Promise<void> {
  if (mode !== "preservePreferences" && mode !== "deleteEverything") {
    throw new TypeError("A valid removal mode is required.");
  }
  await invokeFor(explicitInvoke)("app_prepare_removal", { mode });
}
