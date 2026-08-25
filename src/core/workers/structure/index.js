export { remapSheetAxis, remapSheetAxisResult } from "./runtime.js";

export function createStructureWorker() {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let sequence = 0;
  worker.addEventListener("message", (event) => {
    const request = pending.get(event.data?.requestId);
    if (!request) return;
    pending.delete(event.data.requestId);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  });
  return {
    mutate(object, axis, index, operation) {
      const requestId = `structure-${++sequence}`;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ requestId, object, axis, index, operation });
      });
    },
    dispose() {
      worker.terminate();
      pending.forEach(({ reject }) => reject(new Error("Structure worker disposed.")));
      pending.clear();
    },
  };
}