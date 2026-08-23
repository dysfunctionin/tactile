import { ObjectRenderer } from "../objects/registry/ObjectRenderer.jsx";

export function ObjectSurface({ objectHandle, ...props }) {
  return <ObjectRenderer objectHandle={objectHandle} {...props} />;
}
