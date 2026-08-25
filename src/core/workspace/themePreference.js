export function normalizeThemePreference(value) {
  if (!value || typeof value !== "object") return null;
  const themeId = String(value.themeId || "").trim();
  if (!themeId) return null;
  const colorScheme = value.colorScheme === "dark" ? "dark" : "light";
  const theme = value.theme && typeof value.theme === "object" && value.theme.id === themeId
    ? value.theme
    : null;
  return { themeId, colorScheme, ...(theme ? { theme } : {}) };
}