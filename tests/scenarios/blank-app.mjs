import { createBlankWorkspace } from "../../src/core/workspace/model.js";
import { defineScenarioSetup } from "../harness/scenario-setup.mjs";

/**
 * Default scenario: the app with nothing in it.
 *
 * The workspace is built on first access so the 187 tests that never touch it
 * pay nothing for the default.
 */
export const blankApp = defineScenarioSetup({
  id: "blank-app",
  label: "blank workspace",
  materialize() {
    let workspace = null;
    return {
      get workspace() {
        if (!workspace) workspace = createBlankWorkspace({});
        return workspace;
      },
    };
  },
});
