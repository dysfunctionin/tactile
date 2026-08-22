import { remapSheetAxisResult } from "./runtime.js";

globalThis.addEventListener("message", (event) => {
  const request = event.data;
  try {
    const result = remapSheetAxisResult(request.object, request.axis, request.index, request.operation);
    globalThis.postMessage({ requestId: request.requestId, result });
  } catch (error) {
    globalThis.postMessage({
      requestId: request?.requestId,
      error: error?.message || String(error),
    });
  }
});