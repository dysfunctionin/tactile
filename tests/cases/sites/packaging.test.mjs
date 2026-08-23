import { access } from "node:fs/promises";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "sites", suite: "sites" });

scenario("emits the files required by Sites packaging", async () => {
  await access(new URL("../../../dist/client/index.html", import.meta.url));
  await access(new URL("../../../dist/server/index.js", import.meta.url));
  await access(new URL("../../../dist/.openai/hosting.json", import.meta.url));
});
