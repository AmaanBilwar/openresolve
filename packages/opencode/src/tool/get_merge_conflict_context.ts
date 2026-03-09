import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import DESCRIPTION from "./get_merge_conflict_context.txt"
import { Instance } from "@/project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000

export const GetMergeConflictContext = Tool.define("get_merge_conflict_context", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().optional().describe("Optional file path to scan. If provided, path/include are ignored."),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
    pattern: z.string().optional().describe("The pattern to search for in file contents to list merge conflicts"),
    context: z.coerce.number().optional().describe("Number of lines of context around each conflict"),
    limit: z.coerce.number().optional().describe("Maximum number of conflicts to return"),
    gitContext: z.coerce
      .boolean()
      .optional()
      .describe("Include three-way merge context from git stages (default true)"),
    commitContext: z.coerce
      .boolean()
      .optional()
      .describe("Include recent commit messages for each conflicted file (default false)"),
    maxHunks: z.coerce.number().optional().describe("Maximum number of git conflict hunks to return"),
    maxCommits: z.coerce.number().optional().describe("Maximum number of commit messages to return per file"),
  }),
  async execute(params, ctx) {
    const pattern = params.pattern ?? "^(<<<<<<<|=======|>>>>>>>)( .*)?$"
    const context = params.context ?? 5
    const limit = params.limit ?? 50
    const gitContext = params.gitContext ?? true
    const commitContext = params.commitContext ?? false
    const maxHunks = params.maxHunks ?? 50
    const maxCommits = params.maxCommits ?? 10
    const clip = (line: string) => (line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line)

    await ctx.ask({
      permission: "get_merge_conflict_context",
      patterns: [pattern],
      always: ["*"],
      metadata: {
        pattern,
        path: params.path,
        include: params.include || "*",
        filePath: params.filePath,
        context,
        limit,
        gitContext,
        commitContext,
        maxHunks,
        maxCommits,
      },
    })

    let searchPath = params.filePath ?? params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: params.filePath ? "file" : "directory" })

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|", "--regexp", pattern]
    if (params.include && !params.filePath) {
      args.push("--glob", params.include)
    }
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
    })
    const output = await new Response(proc.stdout).text()
    const errorOutput = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode === 1 || (exitCode === 2 && !output.trim())) {
      return {
        title: pattern,
        metadata: {
          conflicts: 0,
          truncated: false,
          git: gitContext ? { files: [], truncated: false } : undefined,
        },
        output: "No conflicts found",
      }
    }

    if (exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    const hasErrors = exitCode === 2

    const lines = output.trim().split(/\r?\n/)
    const files = new Map<string, number>()

    for (const line of lines) {
      if (!line) continue

      const [filePath] = line.split("|")
      if (!filePath) continue

      if (files.has(filePath)) continue

      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => null)
      if (!stats) continue

      files.set(filePath, stats.mtime.getTime())
    }

    const entries = [...files.entries()].sort((a, b) => b[1] - a[1])
    const items = [] as {
      path: string
      rel: string
      modTime: number
      start: number
      mid: number
      end: number
      lines: string[]
      ours: string[]
      theirs: string[]
    }[]

    for (const [filePath, modTime] of entries) {
      const text = await Bun.file(filePath)
        .text()
        .catch(() => null)
      if (!text) continue

      const fileLines = text.split(/\r?\n/)
      let i = 0
      while (i < fileLines.length) {
        const line = fileLines[i]
        if (!line.startsWith("<<<<<<<")) {
          i += 1
          continue
        }

        const start = i
        let mid = -1
        let end = -1
        let j = i + 1
        while (j < fileLines.length) {
          const next = fileLines[j]
          if (mid === -1 && next.startsWith("=======")) mid = j
          if (next.startsWith(">>>>>>>")) {
            end = j
            break
          }
          j += 1
        }

        if (end === -1) {
          i += 1
          continue
        }

        const contextStart = Math.max(0, start - context)
        const contextEnd = Math.min(fileLines.length - 1, end + context)
        const slice = fileLines.slice(contextStart, contextEnd + 1)
        const rel = path.isAbsolute(filePath) ? path.relative(Instance.directory, filePath) : filePath
        const gitPath = rel.startsWith("..") || path.isAbsolute(rel) ? "" : rel.split(path.sep).join("/")

        items.push({
          path: filePath,
          rel: gitPath,
          modTime,
          start: contextStart + 1,
          mid,
          end: contextEnd + 1,
          lines: slice,
          ours: fileLines.slice(start + 1, mid),
          theirs: fileLines.slice(mid + 1, end),
        })

        i = end + 1
      }
    }

    const totalConflicts = items.length
    if (totalConflicts === 0) {
      return {
        title: pattern,
        metadata: {
          conflicts: 0,
          truncated: false,
          git: gitContext ? { files: [], truncated: false } : undefined,
        },
        output: "No conflicts found",
      }
    }

    const outputLines = [
      `Found ${totalConflicts} conflicts${totalConflicts > limit ? ` (showing first ${limit})` : ""}`,
    ]
    let currentFile = ""
    let shown = 0
    const git = [] as {
      path: string
      hunks: {
        start: number
        end: number
        base: { start: number; end: number; lines: string[] }
        ours: { start: number; end: number; lines: string[] }
        theirs: { start: number; end: number; lines: string[] }
      }[]
      commits?: string[]
      truncated: boolean
    }[]
    const gitMap = new Map<string, { index: number; rel: string }>()
    const cache = new Map<string, { base: string[]; ours: string[]; theirs: string[] }>()
    const find = (lines: string[], part: string[]) => {
      if (part.length === 0) return -1
      for (let i = 0; i <= lines.length - part.length; i += 1) {
        if (lines[i] !== part[0]) continue
        let ok = true
        for (let j = 1; j < part.length; j += 1) {
          if (lines[i + j] === part[j]) continue
          ok = false
          break
        }
        if (ok) return i
      }
      return -1
    }
    const slice = (lines: string[], pos: number, span: number) => {
      const size = span > 0 ? span : 1
      const start = pos === -1 ? 0 : Math.max(0, pos - context)
      const end = pos === -1 ? Math.min(lines.length, size + context * 2) : Math.min(lines.length, pos + size + context)
      const text = lines.slice(start, end).map(clip)
      return { start: start + 1, end: start + text.length, lines: text }
    }
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        signal: ctx.abort,
        cwd: Instance.directory,
      })
      const out = await new Response(proc.stdout).text()
      const err = await new Response(proc.stderr).text()
      const code = await proc.exited
      if (code !== 0) return { ok: false, out, err }
      return { ok: true, out }
    }
    const stages = async (file: string) => {
      const list = await run(["ls-files", "-u", "--", file])
      if (!list.ok || !list.out.trim()) return null
      const lines = list.out.trim().split(/\r?\n/)
      const present = new Set<string>()
      for (const line of lines) {
        const parts = line.split("\t")
        const meta = parts[0]?.trim()
        if (!meta) continue
        const stage = meta.split(/\s+/)[2]
        if (stage) present.add(stage)
      }
      if (!present.has("1") || !present.has("2") || !present.has("3")) return null
      const base = await run(["show", `:1:${file}`])
      if (!base.ok) return null
      const ours = await run(["show", `:2:${file}`])
      if (!ours.ok) return null
      const theirs = await run(["show", `:3:${file}`])
      if (!theirs.ok) return null
      return {
        base: base.out.split(/\r?\n/),
        ours: ours.out.split(/\r?\n/),
        theirs: theirs.out.split(/\r?\n/),
      }
    }

    for (const item of items) {
      if (shown >= limit) break

      if (currentFile !== item.path) {
        if (currentFile !== "") outputLines.push("")
        currentFile = item.path
        outputLines.push(`${item.path}:`)
      }

      outputLines.push(`  Conflict (lines ${item.start}-${item.end}):`)
      for (let i = 0; i < item.lines.length; i++) {
        const lineNum = item.start + i
        outputLines.push(`    ${lineNum}: ${clip(item.lines[i])}`)
      }
      shown += 1
    }

    if (gitContext) {
      let used = 0
      for (const item of items) {
        if (!item.rel) continue
        const data = gitMap.get(item.path)
        if (!data) {
          git.push({ path: item.path, hunks: [], truncated: false })
          gitMap.set(item.path, { index: git.length - 1, rel: item.rel })
        }
        const entry = git[gitMap.get(item.path)!.index]
        if (used >= maxHunks) {
          entry.truncated = true
          continue
        }
        if (!cache.has(item.rel)) {
          const val = await stages(item.rel)
          if (!val) {
            cache.set(item.rel, { base: [], ours: [], theirs: [] })
          } else {
            cache.set(item.rel, val)
          }
        }
        const file = cache.get(item.rel)
        if (!file || file.base.length === 0 || file.ours.length === 0 || file.theirs.length === 0) continue
        const oursPos = find(file.ours, item.ours)
        const theirsPos = find(file.theirs, item.theirs)
        const basePos = oursPos !== -1 ? oursPos : theirsPos
        const span = Math.max(item.ours.length, item.theirs.length, 1)
        entry.hunks.push({
          start: item.start,
          end: item.end,
          base: slice(file.base, basePos, span),
          ours: slice(file.ours, oursPos, item.ours.length),
          theirs: slice(file.theirs, theirsPos, item.theirs.length),
        })
        used += 1
      }
      if (commitContext) {
        for (const item of git) {
          const data = gitMap.get(item.path)
          if (!data?.rel) continue
          const log = await run(["log", "-n", String(maxCommits), "--format=%h %s", "--", data.rel])
          if (!log.ok || !log.out.trim()) continue
          item.commits = log.out.trim().split(/\r?\n/)
        }
      }
    }

    if (totalConflicts > limit) {
      outputLines.push("")
      outputLines.push(
        `(Results truncated: showing ${limit} of ${totalConflicts} conflicts (${totalConflicts - limit} hidden). Consider using a more specific path or file.)`,
      )
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title: pattern,
      metadata: {
        conflicts: totalConflicts,
        truncated: totalConflicts > limit,
        git: gitContext ? { files: git, truncated: git.some((item) => item.truncated) } : undefined,
      },
      output: outputLines.join("\n"),
    }
  },
})
