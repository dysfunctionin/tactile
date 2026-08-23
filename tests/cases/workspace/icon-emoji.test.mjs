import assert from "node:assert/strict";

import { normalizeIconEmoji } from "../../../src/core/workspace/iconEmoji.js";
import { createBlankWorkspace, normalizeWorkspace } from "../../../src/core/workspace/model.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "workspace" });

scenario("normalizes custom icons to the first emoji grapheme", () => {
  assert.equal(normalizeIconEmoji("🎵✌️fbvf"), "🎵");
  assert.equal(normalizeIconEmoji("  👩‍💻  "), "👩‍💻");
  assert.equal(normalizeIconEmoji("🇮🇳"), "🇮🇳");
  assert.equal(normalizeIconEmoji("plain text"), "");
  assert.equal(normalizeIconEmoji(""), "");
});

scenario("normalizes imported object icon metadata without disturbing reset values", () => {
  const workspace = createBlankWorkspace({ id: "emoji-workspace" });
  workspace.objects.home.iconEmoji = "🎵✌️fbvf";

  const normalized = normalizeWorkspace(workspace);
  assert.equal(normalized.objects.home.iconEmoji, "🎵");

  workspace.objects.home.iconEmoji = "";
  const reset = normalizeWorkspace(workspace);
  assert.equal(reset.objects.home.iconEmoji, "");
});
