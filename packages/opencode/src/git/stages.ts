import { Log } from "@/util/log"

const log = Log.create({ service: "git.stages" })

export interface GitRunResult {
  ok: boolean
  out: string
  err?: string
}

export async function gitRun(args: string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
    cwd,
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) return { ok: false, out, err }
  return { ok: true, out }
}

export interface ThreeWayStages {
  base: string
  ours: string
  theirs: string
}

/**
 * Retrieve the three-way merge stages (base / ours / theirs) for a file from
 * the git index.  Returns `null` when the file does not have all three stages
 * recorded (i.e. it is not in a conflicted state).
 *
 * @param file  git-relative path (forward-slashes, no leading `./`)
 * @param cwd   working-tree root so `git` resolves the index correctly
 */
export async function getStages(
  file: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ThreeWayStages | null> {
  const list = await gitRun(["ls-files", "-u", "--", file], cwd, signal)
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

  const [base, ours, theirs] = await Promise.all([
    gitRun(["show", `:1:${file}`], cwd, signal),
    gitRun(["show", `:2:${file}`], cwd, signal),
    gitRun(["show", `:3:${file}`], cwd, signal),
  ])

  if (!base.ok || !ours.ok || !theirs.ok) {
    log.info("failed to read one or more stages", { file })
    return null
  }

  return { base: base.out, ours: ours.out, theirs: theirs.out }
}
