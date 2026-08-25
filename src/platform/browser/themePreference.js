import { normalizeThemePreference } from "../../core/workspace/themePreference.js";

export const THEME_PREFERENCE_KEY = "tactile.theme-preference.v1";

function defaultStorage() {
  return typeof globalThis !== "undefined" ? globalThis.localStorage : null;
}

export function cacheThemePreference(value, storage = defaultStorage()) {
  if (!storage) return null;
  const preference = normalizeThemePreference(value);
  if (!preference) return null;
  try {
    storage.setItem(THEME_PREFERENCE_KEY, JSON.stringify(preference));
    return preference;
  } catch {
    return null;
  }
}

export function loadThemePreference(storage = defaultStorage()) {
  if (!storage) return null;
  try {
    return normalizeThemePreference(JSON.parse(storage.getItem(THEME_PREFERENCE_KEY) || "null"));
  } catch {
    return null;
  }
}

export function saveThemePreference(theme, storage = defaultStorage()) {
  if (!storage || !theme?.id) return null;
  return cacheThemePreference({
    themeId: theme.id,
    colorScheme: theme.tokens?.colorScheme,
    ...(theme.builtIn ? {} : { theme }),
  }, storage);
}