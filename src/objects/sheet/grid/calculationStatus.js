import { useCallback, useSyncExternalStore } from "react";

// A backlog shorter than this settles within a frame or two, so announcing it
// would flicker on every ordinary edit.
const NOTICE_DELAY_MS = 300;
const IDLE = Object.freeze({ pending: 0, busy: false });

const statusByObject = new Map();
const noticeTimers = new Map();
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clearNoticeTimer(objectId) {
  const timer = noticeTimers.get(objectId);
  if (timer === undefined) return;
  clearTimeout(timer);
  noticeTimers.delete(objectId);
}

export function reportCalculationStatus(objectId, pending) {
  if (!objectId) return;
  const previous = statusByObject.get(objectId) || IDLE;
  if (previous.pending === pending) return;

  if (!pending) {
    clearNoticeTimer(objectId);
    statusByObject.delete(objectId);
    if (previous.busy) emit();
    return;
  }

  statusByObject.set(objectId, { pending, busy: previous.busy });
  if (previous.busy) {
    emit();
    return;
  }
  if (noticeTimers.has(objectId)) return;
  noticeTimers.set(objectId, setTimeout(() => {
    noticeTimers.delete(objectId);
    const current = statusByObject.get(objectId);
    if (!current?.pending) return;
    statusByObject.set(objectId, { pending: current.pending, busy: true });
    emit();
  }, NOTICE_DELAY_MS));
}

export function clearCalculationStatus(objectId) {
  reportCalculationStatus(objectId, 0);
}

export function useCalculationStatus(objectId) {
  const getSnapshot = useCallback(() => statusByObject.get(objectId) || IDLE, [objectId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => IDLE);
}
