import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function fmtMs(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} ms`;
}

export function fmtBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) > 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (Math.abs(value) > 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function fmtMB(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} MB`;
}
