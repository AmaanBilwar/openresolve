import { Language } from "web-tree-sitter"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsersConfig from "../../parsers-config.ts"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"

export type { Tree } from "web-tree-sitter"

const log = Log.create({ service: "treesitter" })

const WASM_CACHE_DIR = path.join(Global.Path.cache, "treesitter-wasm")

const PARSER_WASM_URLS: Record<string, string> = Object.fromEntries(
  parsersConfig.parsers.map((p: { filetype: string; wasm: string }) => [p.filetype, p.wasm]),
)

// LSP language IDs that differ from their tree-sitter filetype name.
// Identically-named pairs (python→python, rust→rust, …) fall through automatically.
const LSP_TO_TREESITTER: Record<string, string> = {
  shellscript: "bash",
  javascriptreact: "javascript",
  typescriptreact: "typescript",
}

// Extensions missing from LANGUAGE_EXTENSIONS that have parsers in parsers-config
const EXTRA_EXTENSIONS: Record<string, string> = {
  ".jl": "julia",
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const init = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  await fs.mkdir(WASM_CACHE_DIR, { recursive: true })
  log.info("tree-sitter WASM runtime initialized")
  return Parser
})

const languageLoads = new Map<string, Promise<Language>>()
const parserCache = new Map<string, Promise<import("web-tree-sitter").Parser>>()

async function fetchAndCacheWasm(url: string, lang: string): Promise<string> {
  const filename = `tree-sitter-${lang}.wasm`
  const cachedPath = path.join(WASM_CACHE_DIR, filename)

  try {
    await fs.access(cachedPath)
    return cachedPath
  } catch {
    // not cached yet
  }

  log.info("fetching tree-sitter WASM", { lang, url })
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM for ${lang}: ${response.status} ${response.statusText}`)
  }
  const buffer = await response.arrayBuffer()
  await fs.writeFile(cachedPath, Buffer.from(buffer))
  log.info("cached tree-sitter WASM", { lang, path: cachedPath })
  return cachedPath
}

function loadLanguage(lang: string): Promise<Language> {
  const existing = languageLoads.get(lang)
  if (existing) return existing

  const promise = (async () => {
    await init()
    const wasmUrl = PARSER_WASM_URLS[lang]
    if (!wasmUrl) {
      throw new Error(
        `No tree-sitter parser available for "${lang}". Supported: ${Object.keys(PARSER_WASM_URLS).join(", ")}`,
      )
    }
    const wasmPath = await fetchAndCacheWasm(wasmUrl, lang)
    return Language.load(wasmPath)
  })()

  promise.catch(() => languageLoads.delete(lang))
  languageLoads.set(lang, promise)
  return promise
}

export namespace TreeSitter {
  /**
   * Get or create a cached Parser instance for the given tree-sitter language.
   * The WASM runtime is lazily initialized on first call, and language WASMs
   * are fetched from parsers-config.ts URLs and cached to disk.
   */
  export async function parser(lang: string) {
    const existing = parserCache.get(lang)
    if (existing) return existing

    const promise = (async () => {
      const Parser = await init()
      const language = await loadLanguage(lang)
      const p = new Parser()
      p.setLanguage(language)
      return p
    })()

    promise.catch(() => parserCache.delete(lang))
    parserCache.set(lang, promise)
    return promise
  }

  /** Parse source code into a Tree for the given tree-sitter language. */
  export async function parse(source: string, lang: string) {
    const p = await parser(lang)
    const tree = p.parse(source)
    if (!tree) throw new Error(`Failed to parse source as ${lang}`)
    return tree
  }

  /** List all tree-sitter language names that have WASM parsers available. */
  export function supportedLanguages(): string[] {
    return Object.keys(PARSER_WASM_URLS)
  }

  /**
   * Resolve a file extension (e.g. ".py", ".rs") to a tree-sitter language name.
   * Returns undefined if no parser is available for this extension.
   */
  export function languageFromExtension(ext: string): string | undefined {
    const lspLang = LANGUAGE_EXTENSIONS[ext]
    if (lspLang) {
      const tsLang = LSP_TO_TREESITTER[lspLang] ?? lspLang
      if (tsLang in PARSER_WASM_URLS) return tsLang
    }
    const direct = EXTRA_EXTENSIONS[ext]
    if (direct && direct in PARSER_WASM_URLS) return direct
    return undefined
  }

  /**
   * Resolve a file path to a tree-sitter language name by extracting its extension.
   * Returns undefined if no parser is available for this file type.
   */
  export function languageFromPath(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase()
    if (!ext) return undefined
    return languageFromExtension(ext)
  }

  /**
   * Convenience: parse a file's source code, auto-detecting the language from the path.
   * Throws if the language cannot be determined or no parser is available.
   */
  export async function parseFile(source: string, filePath: string) {
    const lang = languageFromPath(filePath)
    if (!lang) {
      throw new Error(
        `No tree-sitter parser for "${path.extname(filePath)}" files. Supported: ${supportedLanguages().join(", ")}`,
      )
    }
    return parse(source, lang)
  }
}
