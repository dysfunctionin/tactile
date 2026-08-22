import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const cardVariants = cva("rounded-lg border border-border bg-card text-card-foreground shadow-sm");

export function Card({ className, ...props }) {
  return <div className={cn(cardVariants(), className)} {...props} />;
}

export function CardHeader({ className, ...props }) {
  return <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn("text-sm font-medium tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }) {
  return <div className={cn("p-5 pt-2", className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-muted-foreground",
        success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        destructive: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

const buttonVariants = cva(
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-border bg-background hover:bg-accent",
        ghost: "hover:bg-accent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Button({ className, variant, ...props }) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export function Separator({ className, ...props }) {
  return <div className={cn("h-px w-full shrink-0 bg-border", className)} {...props} />;
}
