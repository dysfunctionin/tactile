import assert from "node:assert/strict";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "release" });

import {
  compareAppVersions,
  nextAlphaVersion,
  parseAppVersion,
  windowsBundleVersion,
} from "../../../scripts/release/app-version.mjs";

scenario("parses supported app release versions", () => {
  assert.deepEqual(parseAppVersion("v1.2.3-alpha.4"), {
    version: "1.2.3-alpha.4",
    major: 1,
    minor: 2,
    patch: 3,
    channel: "alpha",
    build: 4,
  });
  assert.equal(parseAppVersion("1.2.3").channel, null);
  assert.throws(() => parseAppVersion("1.2.3-beta.1"), /Invalid app version/);
  assert.throws(() => parseAppVersion("1.2.3-alpha.10000"), /between 1 and 9999/);
});

scenario("selects the next unused alpha version", () => {
  assert.equal(nextAlphaVersion("1.1.1"), "1.1.2-alpha.1");
  assert.equal(nextAlphaVersion("1.1.2-alpha.2"), "1.1.2-alpha.3");
  assert.equal(nextAlphaVersion("1.1.2-alpha.2", ["v1.1.2-alpha.3", "v1.1.2-alpha.5"]), "1.1.2-alpha.6");
  assert.throws(() => nextAlphaVersion("1.1.2-rc.1"), /explicit alpha version/);
});

scenario("orders alpha, RC, and stable versions", () => {
  assert.equal(compareAppVersions("1.2.0-alpha.2", "1.2.0-alpha.1"), 1);
  assert.equal(compareAppVersions("1.2.0-rc.1", "1.2.0-alpha.9"), 1);
  assert.equal(compareAppVersions("1.2.0", "1.2.0-rc.9"), 1);
});

scenario("projects canonical versions to MSI-safe numeric prereleases", () => {
  assert.equal(windowsBundleVersion("1.1.2-alpha.3"), "1.1.2-10003");
  assert.equal(windowsBundleVersion("1.1.2-rc.3"), "1.1.2-20003");
  assert.equal(windowsBundleVersion("1.1.2"), "1.1.2");
});
