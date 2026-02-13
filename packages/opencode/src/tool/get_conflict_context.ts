import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import DESCRIPTION from "./get_conflict_context.txt"
import { Instance } from "@/project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000

export const GetConflictContext = Tool.define("get_conflict_context", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().optional().describe("Optional file path to scan. If provided, path/include are ignored."),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
    pattern: z.string().optional().describe("The pattern to search for in file contents to list merge conflicts"),
    context: z.coerce.number().optional().describe("Number of lines of context around each conflict"),
    limit: z.coerce.number().optional().describe("Maximum number of conflicts to return"),
  }),
  async execute(params, ctx) {
    const pattern = params.pattern ?? "^(<<<<<<<|=======|>>>>>>>)( .*)?$"
    const context = params.context ?? 5
    const limit = params.limit ?? 50

    await ctx.ask({
      permission: "get_conflict_context",
      patterns: [pattern],
      always: ["*"],
      metadata: {
        pattern,
        path: params.path,
        include: params.include || "*",
        filePath: params.filePath,
        context,
        limit,
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
        metadata: { conflicts: 0, truncated: false },
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
      modTime: number
      start: number
      end: number
      lines: string[]
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

        items.push({
          path: filePath,
          modTime,
          start: contextStart + 1,
          end: contextEnd + 1,
          lines: slice,
        })

        i = end + 1
      }
    }

    const totalConflicts = items.length
    if (totalConflicts === 0) {
      return {
        title: pattern,
        metadata: { conflicts: 0, truncated: false },
        output: "No conflicts found",
      }
    }

    const outputLines = [
      `Found ${totalConflicts} conflicts${totalConflicts > limit ? ` (showing first ${limit})` : ""}`,
    ]
    let currentFile = ""
    let shown = 0

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
        const line =
          item.lines[i].length > MAX_LINE_LENGTH ? item.lines[i].substring(0, MAX_LINE_LENGTH) + "..." : item.lines[i]
        outputLines.push(`    ${lineNum}: ${line}`)
      }
      shown += 1
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
      },
      output: outputLines.join("\n"),
    }
  },
})
