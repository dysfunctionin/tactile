import path from "node:path";

/**
 * Resolves the spec file that registered a scenario.
 *
 * Both runners register scenarios from inside the harness, so the caller must
 * be recovered from the stack for the record to point at the real file.
 */
export function callerFile() {
  const original = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, stack) => stack;
    const frames = new Error().stack;
    for (const frame of frames.slice(1)) {
      const fileName = frame.getFileName?.();
      if (!fileName) continue;
      const normalized = fileName.startsWith("file:") ? fileURLToPathCompat(fileName) : fileName;
      if (normalized.includes(`${path.sep}harness${path.sep}`) || normalized.includes("/harness/")) continue;
      if (normalized.startsWith("node:")) continue;
      return normalized;
    }
    return null;
  } finally {
    Error.prepareStackTrace = original;
  }
}

function fileURLToPathCompat(value) {
  const pathname = new URL(value).pathname;
  return decodeURIComponent(pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}
