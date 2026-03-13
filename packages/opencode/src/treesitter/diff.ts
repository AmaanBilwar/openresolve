import type { Node as SyntaxNode, Tree } from "web-tree-sitter"

export interface NodeRange {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
  startIndex: number
  endIndex: number
}

export interface Change {
  action: "added" | "removed" | "modified"
  /** The relevant node: from modified tree (added/modified) or base tree (removed) */
  node: SyntaxNode
  nodeType: string
  range: NodeRange
  /** For "modified": the corresponding node in the base tree */
  baseNode?: SyntaxNode
  /** For "modified": the range in the base tree */
  baseRange?: NodeRange
  /** Start row in the base tree affected by this change (inclusive). */
  baseStartRow: number
  /** End row in the base tree affected by this change (inclusive). */
  baseEndRow: number
}

function rangeFrom(node: SyntaxNode): NodeRange {
  return {
    startRow: node.startPosition.row,
    startColumn: node.startPosition.column,
    endRow: node.endPosition.row,
    endColumn: node.endPosition.column,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  }
}

/**
 * Identity key for matching nodes across tree versions.
 * Named declarations use type + name for stable identity across edits.
 * Unnamed nodes use type alone and rely on positional LCS alignment.
 */
function nodeKey(node: SyntaxNode): string {
  const name = node.childForFieldName("name")
  if (name) return `${node.type}::${name.text}`
  return node.type
}

/**
 * Standard DP-based Longest Common Subsequence on string keys.
 * Returns matched (baseIndex, modIndex) pairs in order.
 */
function lcs(baseKeys: string[], modKeys: string[]): [number, number][] {
  const m = baseKeys.length
  const n = modKeys.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        baseKeys[i - 1] === modKeys[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const pairs: [number, number][] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (baseKeys[i - 1] === modKeys[j - 1]) {
      pairs.push([i - 1, j - 1])
      i--
      j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return pairs.reverse()
}

const COMPOUND_TYPES = new Set([
  "program",
  "module",
  "source_file",
  "translation_unit",
  "class_definition",
  "class_declaration",
  "class_body",
  "function_definition",
  "function_declaration",
  "method_definition",
  "method_declaration",
  "block",
  "statement_block",
  "compound_statement",
  "module_body",
])

function isCompound(node: SyntaxNode): boolean {
  return COMPOUND_TYPES.has(node.type)
}

function structuralChildren(node: SyntaxNode): SyntaxNode[] {
  return (node.namedChildren as (SyntaxNode | null)[]).filter((c): c is SyntaxNode => c !== null)
}

/**
 * Compute a list of structural changes between two independently parsed trees.
 * Changes are reported at meaningful AST boundaries (functions, classes,
 * statements, blocks) rather than individual tokens.
 *
 * Each change carries `baseStartRow` / `baseEndRow` indicating which region of
 * the base tree it affects — this enables downstream overlap detection when
 * comparing two independent diffs against the same base.
 */
export function diffTrees(baseTree: Tree, modifiedTree: Tree): Change[] {
  const changes: Change[] = []
  diffChildren(baseTree.rootNode, modifiedTree.rootNode, changes)
  return changes
}

function diffChildren(baseParent: SyntaxNode, modParent: SyntaxNode, changes: Change[]): void {
  const baseKids = structuralChildren(baseParent)
  const modKids = structuralChildren(modParent)

  const baseKeys = baseKids.map(nodeKey)
  const modKeys = modKids.map(nodeKey)

  const matched = lcs(baseKeys, modKeys)

  const matchedBaseSet = new Set<number>()
  const matchedModSet = new Set<number>()
  const modToBase = new Map<number, number>()

  for (const [bi, mi] of matched) {
    matchedBaseSet.add(bi)
    matchedModSet.add(mi)
    modToBase.set(mi, bi)
  }

  for (let i = 0; i < baseKids.length; i++) {
    if (matchedBaseSet.has(i)) continue
    const node = baseKids[i]
    changes.push({
      action: "removed",
      node,
      nodeType: node.type,
      range: rangeFrom(node),
      baseStartRow: node.startPosition.row,
      baseEndRow: node.endPosition.row,
    })
  }

  for (let i = 0; i < modKids.length; i++) {
    if (matchedModSet.has(i)) continue
    const node = modKids[i]

    // Determine the affected base row range by walking outward to the
    // nearest matched siblings and using their base-tree positions.
    let prevBaseRow = baseParent.startPosition.row
    let nextBaseRow = baseParent.endPosition.row

    for (let j = i - 1; j >= 0; j--) {
      const bi = modToBase.get(j)
      if (bi !== undefined) {
        prevBaseRow = baseKids[bi].endPosition.row
        break
      }
    }
    for (let j = i + 1; j < modKids.length; j++) {
      const bi = modToBase.get(j)
      if (bi !== undefined) {
        nextBaseRow = baseKids[bi].startPosition.row
        break
      }
    }

    changes.push({
      action: "added",
      node,
      nodeType: node.type,
      range: rangeFrom(node),
      baseStartRow: prevBaseRow,
      baseEndRow: nextBaseRow,
    })
  }

  for (const [bi, mi] of matched) {
    const base = baseKids[bi]
    const mod = modKids[mi]
    if (base.text === mod.text) continue

    if (isCompound(base) && isCompound(mod)) {
      diffChildren(base, mod, changes)
    } else {
      changes.push({
        action: "modified",
        node: mod,
        nodeType: mod.type,
        range: rangeFrom(mod),
        baseNode: base,
        baseRange: rangeFrom(base),
        baseStartRow: base.startPosition.row,
        baseEndRow: base.endPosition.row,
      })
    }
  }
}
