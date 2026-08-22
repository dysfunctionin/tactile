# 03 — Typing burst (24-key input)

## Current time
From suite runs (median, one repeat):

| Profile | duration baseline → final | input p95 baseline → final | frame p95 baseline → final | longtasks baseline → final |
|---|---|---|---|---|
| low | 2191 → 2176 ms | 41 → 32 ms | 16.8 → 16.7 ms | 0 → 0 |
| high | 7723 → 4434 ms | 80 → 264 ms* | 66.7 → 16.8 ms | 45 → 4 |

\* `high/input p95` single-repeat artefact: p95 == max == 264 ms over 24 samples means exactly one
keystroke stalled (GC/commit task); the frame-time signal is at budget and 41 long tasks dropped to 4.

Bookmark where we are: the earlier draft-split already moved per-keystroke work off the path — typing duration and frame p95 are much better. **Commit-time** still hurts.

## Why it is slow (measured on the high fixture)

Typing *itself* (the 24 draft keystrokes) is fine — that was fixed by the earlier draft-split. The
remaining time is spent in the **commit at Enter** plus one-off stalls:

1. **Formula engine on commit — ~1.4 s.** A single edited cell invokes `applyChanges`, which on a
   25k-formula sheet iterates all formula addresses, fans out through row-indexed range dependents,
   and re-evaluates the affected band (`formulas.js:948,736-758`, see `11-formula-engine.md`).
2. **Shadow differential on commit — ~2.6 s.** One changed cell ≤ 20k, so the diagnostics run
   4× `normalizeWorkspace` (658 ms each) + a whole-workspace deep compare (`shadow.js:408-417`).
3. **Boot-cache stringify — ~180 ms/commit** (`storage.js:28-55`).
4. **Render scans — ~120 ms**: `embeddedTypes` `Object.values` (~53 ms), `autoRowHeights` (~68 ms),
   plus per-mounted-cell prop compute in the canvas before memos bail (`SheetGridCanvas.jsx:353-363`).
5. One-off stalls (the 264 ms input-p95 sample) are single keystrokes that hit a long macrotask
   (cache flush) or GC after a commit burst.

So a commit on the high fixture costs **~1.4 s sync (render) + ~2.6 s in microtasks + ~0.2 s
macrotask** — which is why typing-burst is still 4.4 s even though per-keystroke work is gone.

## Plan
- **`11` engine (main)**: change-selective recalculation + coverage range index + never iterate all
  formulas → single-edit engine cost 1.4 s → < 15 ms.
- **`10` differential**: gate the diagnostics off the hot path (run only when explicitly enabled,
  or once per N revisions) → removes ~2.6 s/commit; coalesce reconcile to one per rAF.
- **`10` cache**: throttle the localStorage flush to ≤1/s + `pagehide` → removes the ~0.2 s macrotask.
- **P2** Journal-driven projections (remove the ~120 ms render scans).
- **P1.4/P4** One formula engine; no worker mirror per keystroke commit.
- **P3** Offset addressing makes structural ops formula-free (typing doesn't need it).
- Re-run the typing scenario with `--repeats 3` so input p95 is a stable median, not a single-sample spike.

## Expected time
- duration: low **≤ 1800 ms**, high **≤ 1800 ms** (from 4434 ms).
- input p95 (3-repeat median): low **≤ 40 ms**, high **≤ 60 ms**; no keystroke above 100 ms.
- frame p95: **≤ 16.7 ms** both profiles (already there).

## Gate
`npm run bench:suite -- --profiles low,high --repeats 3 --label typing` — pass if high input p95 median ≤ 60 ms, high duration ≤ 2800 ms, and P0 stage timers show no commit-time stall > 50 ms.