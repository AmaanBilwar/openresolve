import type { Change } from "./diff"

export interface OverlapPair {
  ours: Change
  theirs: Change
  /** First overlapping row in the base tree (inclusive). */
  overlapStartRow: number
  /** Last overlapping row in the base tree (inclusive). */
  overlapEndRow: number
}

export interface OverlapResult {
  /** Changes that affect disjoint base-tree regions — safe for auto-merge. */
  nonOverlapping: {
    ours: Change[]
    theirs: Change[]
  }
  /** Pairs of changes that touch the same base-tree region — need resolution. */
  overlapping: OverlapPair[]
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/**
 * Classify two independent change sets (both diffed against the same base tree)
 * into overlapping vs. non-overlapping groups.
 *
 * Non-overlapping changes affect disjoint regions of the base and can
 * typically be auto-merged at node boundaries.
 *
 * Overlapping changes modify the same base-tree region from both branches
 * and require explicit resolution (manual or intent-based).
 */
export function classifyOverlaps(oursChanges: Change[], theirsChanges: Change[]): OverlapResult {
  const oursInOverlap = new Set<number>()
  const theirsInOverlap = new Set<number>()
  const overlapping: OverlapPair[] = []

  for (let i = 0; i < oursChanges.length; i++) {
    const ours = oursChanges[i]
    for (let j = 0; j < theirsChanges.length; j++) {
      const theirs = theirsChanges[j]

      if (!rangesOverlap(ours.baseStartRow, ours.baseEndRow, theirs.baseStartRow, theirs.baseEndRow)) continue

      oursInOverlap.add(i)
      theirsInOverlap.add(j)

      overlapping.push({
        ours,
        theirs,
        overlapStartRow: Math.max(ours.baseStartRow, theirs.baseStartRow),
        overlapEndRow: Math.min(ours.baseEndRow, theirs.baseEndRow),
      })
    }
  }

  return {
    nonOverlapping: {
      ours: oursChanges.filter((_, i) => !oursInOverlap.has(i)),
      theirs: theirsChanges.filter((_, i) => !theirsInOverlap.has(i)),
    },
    overlapping,
  }
}
