// Playwright actions the harness times. Read-only queries are left alone so
// the step list stays a record of interactions rather than assertions.
const TIMED_METHODS = new Set([
  "goto",
  "reload",
  "goBack",
  "goForward",
  "click",
  "dblclick",
  "tap",
  "fill",
  "press",
  "type",
  "hover",
  "focus",
  "blur",
  "check",
  "uncheck",
  "selectOption",
  "setInputFiles",
  "dragTo",
  "scrollIntoViewIfNeeded",
  "waitFor",
  "waitForSelector",
  "waitForLoadState",
  "waitForURL",
  "waitForTimeout",
  "waitForFunction",
]);

// Methods that return another locator, which must stay instrumented so a
// chained call is still timed.
const LOCATOR_FACTORIES = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByTitle",
  "getByAltText",
  "first",
  "last",
  "nth",
  "filter",
  "and",
  "or",
]);

function describe(target, method, args = []) {
  let subject = "";
  try {
    subject = String(target);
  } catch {
    subject = "";
  }
  subject = subject.replace(/^Locator@/, "").trim();
  if (subject && subject !== "[object Object]") return `${method} ${subject}`;
  // keyboard and URL calls have no useful subject, so name them by argument.
  const hint = typeof args[0] === "string" && args[0].length <= 40 ? ` ${args[0]}` : "";
  return `${method}${hint}`;
}

/**
 * Wraps a Playwright page so every interaction is recorded as a timed step.
 *
 * The proxy forwards everything else untouched, including internal symbols, so
 * proxied locators still work with `expect`.
 */
export function instrumentBrowser(target, step, seen = new WeakMap()) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return target;
  const cached = seen.get(target);
  if (cached) return cached;

  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== "string") return value;

      // keyboard and mouse are objects whose methods should also be timed.
      if ((property === "keyboard" || property === "mouse") && value && typeof value === "object") {
        return instrumentBrowser(value, step, seen);
      }
      if (typeof value !== "function") return value;

      if (LOCATOR_FACTORIES.has(property)) {
        return (...args) => instrumentBrowser(value.apply(object, args), step, seen);
      }
      if (TIMED_METHODS.has(property)) {
        return (...args) => step(describe(object, property, args), () => value.apply(object, args));
      }
      return value;
    },
  });

  seen.set(target, proxy);
  return proxy;
}
