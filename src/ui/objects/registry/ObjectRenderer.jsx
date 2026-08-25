import { lazy, Suspense, useSyncExternalStore } from "react";
import {
  getObjectTypeDefinition,
  listObjectTypeDefinitions,
  loadObjectRenderer,
  objectTypeRegistryVersion,
  subscribeObjectTypeDefinitions,
} from "./index.js";

const lazyRenderers = new Map();

function lazyObjectRenderer(type, version = objectTypeRegistryVersion()) {
  const key = `${type}:${version}`;
  if (lazyRenderers.has(key)) return lazyRenderers.get(key);
  const Renderer = lazy(async () => {
    const Renderer = await loadObjectRenderer(type);
    return { default: Renderer };
  });
  lazyRenderers.set(key, Renderer);
  return Renderer;
}

// This map preserves the old synchronous lookup surface for callers that
// register a renderer directly, while built-in renderers load on demand.
export const OBJECT_RENDERERS = Object.fromEntries(
  listObjectTypeDefinitions().map((definition) => [definition.type, lazyObjectRenderer(definition.type)]),
);

export function registerObjectRenderer(type, renderer) {
  if (!type || typeof renderer !== "function") throw new Error("Object types need a key and renderer.");
  OBJECT_RENDERERS[type] = renderer;
}

export function ObjectRenderer({ objectHandle, workspaceObjectsHandle, ...props }) {
  const object = objectHandle.current;
  const version = useSyncExternalStore(
    subscribeObjectTypeDefinitions,
    objectTypeRegistryVersion,
    objectTypeRegistryVersion,
  );
  const definition = getObjectTypeDefinition(object.type);
  const Renderer = version === 0
    ? OBJECT_RENDERERS[definition.type] || lazyObjectRenderer(definition.type, version)
    : lazyObjectRenderer(definition.type, version);
  return (
    <Suspense fallback={null}>
      {definition.type === "sheet"
        ? <Renderer objectHandle={objectHandle} workspaceObjectsHandle={workspaceObjectsHandle} {...props} />
        : <Renderer object={object} workspaceObjects={workspaceObjectsHandle.current} {...props} />}
    </Suspense>
  );
}

export function preloadObjectRenderer(type) {
  return loadObjectRenderer(type).catch(() => null);
}
