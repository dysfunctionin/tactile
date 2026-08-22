import * as React from "react";
import { cn } from "../../lib/utils";

export function Tabs({ value, onValueChange, className, children }) {
  return (
    <div className={className} data-state={value}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { currentValue: value, onValueChange })
          : child,
      )}
    </div>
  );
}

export function TabsList({ className, children }) {
  return (
    <div
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({ value, currentValue, onValueChange, className, children }) {
  const active = currentValue === value;
  return (
    <button
      type="button"
      onClick={() => onValueChange?.(value)}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all",
        active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, currentValue, className, children }) {
  if (currentValue !== value) return null;
  return <div className={cn("mt-4", className)}>{children}</div>;
}
