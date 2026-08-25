import assert from "node:assert/strict";

import {
  createBlankWorkspace,
  createCellRecord,
  createSheetObject,
  normalizeWorkspace,
} from "../../../src/core/workspace/model.js";
import {
  NAVIGATION_ROUTE_FORMAT,
  NAVIGATION_ROUTE_VERSION,
  deriveObjectPath,
  homeStackFromWorkspace,
  navigationIntentFromState,
  navigationIntentFromUrl,
  resolveHomePath,
  resolveNavigationIntent,
  visibleLayerWindow,
} from "../../../src/ui/shell/inOut.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "shell" });

function nestedWorkspace() {
  const workspace = createBlankWorkspace({ id: "navigation-test" });
  const root = workspace.objects.home;
  const child = createSheetObject({ id: "child", title: "Child" });
  const grandchild = createSheetObject({ id: "grandchild", title: "Grandchild" });
  root.cells.r1c1 = createCellRecord(0, 0, {
    value: child.title,
    embed: { objectId: child.id, type: child.type },
  });
  child.cells.r2c2 = createCellRecord(1, 1, {
    value: grandchild.title,
    embed: { objectId: grandchild.id, type: grandchild.type },
  });
  workspace.objects = { [root.id]: root, [child.id]: child, [grandchild.id]: grandchild };
  return workspace;
}

scenario("derives the full containment path for an older nested home", () => {
  const workspace = nestedWorkspace();
  workspace.homeObjectId = "grandchild";

  assert.deepEqual(
    deriveObjectPath(workspace.objects, "grandchild").map(({ objectId, sourceObjectId, sourceAddress }) => ({
      objectId,
      sourceObjectId,
      sourceAddress,
    })),
    [
      { objectId: "child", sourceObjectId: "home", sourceAddress: "A1" },
      { objectId: "grandchild", sourceObjectId: "child", sourceAddress: "B2" },
    ],
  );
  const normalized = normalizeWorkspace(workspace);
  assert.equal(normalized.objects.child.parent.parentObjectId, "home");
  assert.equal(normalized.objects.grandchild.parent.parentObjectId, "child");
  assert.equal(normalized.objects.home.cells.r1c1.embed.relation, "containment");
  assert.deepEqual(
    homeStackFromWorkspace(workspace).map((entry) => entry.mode),
    ["full", "full"],
  );
});

scenario("preserves a saved home route when an object has multiple parents", () => {
  const workspace = nestedWorkspace();
  const alternate = createSheetObject({ id: "alternate", title: "Alternate" });
  alternate.cells.r3c3 = createCellRecord(2, 2, {
    value: "Grandchild",
    embed: { objectId: "grandchild", type: "sheet" },
  });
  workspace.objects = {
    home: workspace.objects.home,
    child: workspace.objects.child,
    alternate,
    grandchild: workspace.objects.grandchild,
  };

  assert.deepEqual(
    resolveHomePath(workspace.objects, "grandchild", [
      { objectId: "grandchild", sourceObjectId: "alternate", sourceAddress: "C3" },
    ]).map(({ objectId, sourceObjectId, sourceAddress }) => ({
      objectId,
      sourceObjectId,
      sourceAddress,
    })),
    [{ objectId: "grandchild", sourceObjectId: "alternate", sourceAddress: "C3" }],
  );
});

scenario("resolves compact reload intent only against its authoritative workspace", () => {
  const workspace = normalizeWorkspace(nestedWorkspace());
  const path = deriveObjectPath(workspace.objects, "grandchild");
  const intent = {
    format: NAVIGATION_ROUTE_FORMAT,
    version: NAVIGATION_ROUTE_VERSION,
    workspaceId: workspace.id,
    rootObjectId: "home",
    linkIds: path.map((entry) => entry.linkId),
    mode: "full",
  };

  assert.deepEqual(navigationIntentFromState({ tactileRoute: intent }), intent);
  assert.equal(resolveNavigationIntent(intent, workspace.objects, "provisional-workspace"), null);
  assert.deepEqual(
    resolveNavigationIntent(intent, workspace.objects, workspace.id).map((entry) => entry.objectId),
    ["child", "grandchild"],
  );
});

scenario("parses a compact route from the URL without workspace objects", () => {
  assert.deepEqual(
    navigationIntentFromUrl(
      "https://tactile.test/?workspace=navigation-test&root=home&route=home-child,child-grandchild&mode=full",
    ),
    {
      format: NAVIGATION_ROUTE_FORMAT,
      version: NAVIGATION_ROUTE_VERSION,
      workspaceId: "navigation-test",
      rootObjectId: "home",
      linkIds: ["home-child", "child-grandchild"],
      mode: "full",
    },
  );
});

scenario("projects a deep logical route to only its active parent and leaf", () => {
  const logicalLayers = Array.from({ length: 6 }, (_, index) => ({ objectId: `layer-${index}` }));
  const visible = visibleLayerWindow(logicalLayers);

  assert.equal(visible.start, 4);
  assert.deepEqual(
    visible.layers.map((layer) => layer.objectId),
    ["layer-4", "layer-5"],
  );
});
