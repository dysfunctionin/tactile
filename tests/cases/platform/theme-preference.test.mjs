import assert from "node:assert/strict";

import { defineSuite } from "../../harness/index.mjs";
import {
  THEME_PREFERENCE_KEY,
  loadThemePreference,
  saveThemePreference,
} from "../../../src/platform/browser/themePreference.js";
import {
  loadNativeThemePreference,
  prepareNativeRemoval,
  saveNativeThemePreference,
} from "../../../src/platform/tauri/preferences.ts";

const scenario = defineSuite({ type: "platform", suite: "theme-preference" });

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

scenario("a built-in theme preference survives storage round trips", () => {
  const storage = memoryStorage();
  const saved = saveThemePreference(
    {
      id: "github-dark",
      builtIn: true,
      tokens: { colorScheme: "dark" },
    },
    storage,
  );

  assert.deepEqual(saved, { themeId: "github-dark", colorScheme: "dark" });
  assert.deepEqual(loadThemePreference(storage), saved);
});

scenario("a selected custom theme carries its definition between workspaces", () => {
  const storage = memoryStorage();
  const theme = {
    id: "custom-paper",
    name: "Custom paper",
    builtIn: false,
    tokens: { colorScheme: "light", paper: "#fefefe" },
  };

  const saved = saveThemePreference(theme, storage);

  assert.deepEqual(saved, { themeId: theme.id, colorScheme: "light", theme });
  assert.deepEqual(loadThemePreference(storage), saved);
});

scenario("malformed theme storage falls back without throwing", () => {
  const storage = memoryStorage({ [THEME_PREFERENCE_KEY]: "not-json" });

  assert.equal(loadThemePreference(storage), null);
});

scenario("native preferences load the versioned theme record", async () => {
  const preference = { themeId: "github-dark", colorScheme: "dark" };
  const calls = [];

  const loaded = await loadNativeThemePreference(async (command, payload) => {
    calls.push({ command, payload });
    return { version: 1, theme: preference };
  });

  assert.deepEqual(loaded, preference);
  assert.deepEqual(calls, [{ command: "preferences_load", payload: {} }]);
});

scenario("native preferences save a validated custom theme", async () => {
  const preference = {
    themeId: "custom-paper",
    colorScheme: "light",
    theme: { id: "custom-paper", name: "Paper" },
  };
  const calls = [];

  const saved = await saveNativeThemePreference(preference, async (command, payload) => {
    calls.push({ command, payload });
    return { version: 1, theme: payload.preference };
  });

  assert.deepEqual(saved, preference);
  assert.deepEqual(calls, [
    {
      command: "preferences_save_theme",
      payload: { preference },
    },
  ]);
});

scenario("native preferences reject malformed command responses", async () => {
  await assert.rejects(
    saveNativeThemePreference({ themeId: "paper-public", colorScheme: "light" }, async () => ({
      version: 1,
      theme: null,
    })),
    /invalid theme/,
  );
});

scenario("native removal sends an explicit cleanup mode", async () => {
  const calls = [];
  await prepareNativeRemoval("preservePreferences", async (command, payload) => {
    calls.push({ command, payload });
  });

  assert.deepEqual(calls, [
    {
      command: "app_prepare_removal",
      payload: { mode: "preservePreferences" },
    },
  ]);
  await assert.rejects(
    prepareNativeRemoval("invalid", async () => {}),
    /valid removal mode/,
  );
});
