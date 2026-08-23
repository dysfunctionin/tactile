/**
 * Wraps an object so each of its method calls is recorded as a timed step.
 *
 * Used by tests that drive an adapter or port, so per-operation latency is
 * reported without wrapping every call site by hand.
 */
export function instrumentObject(target, step, label) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return target;
  const prefix = label ? `${label}.` : "";

  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args) => step(`${prefix}${property}`, () => value.apply(object, args));
    },
  });
}
