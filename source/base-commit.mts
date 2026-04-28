import type { SpawnGit } from "./diff.mts"
import { parseIgnorePatterns, isPathIgnored } from "./ignore-patterns.mts"

export interface BaseCommitContext {
	fileList: string[]
	fileContents: Map<string, string>
}

// Reasonable list of common text file extensions found in typical GitHub repositories.
// Not exhaustive — intended to cover the 99% case without needing complex text/binary heuristics.
const TEXT_FILE_EXTENSIONS = new Set([
	// JavaScript / TypeScript
	"js",
	"mjs",
	"cjs",
	"jsx",
	"ts",
	"tsx",
	"mts", // Also an MPEG Transport Stream video format, but text takes precedence for a code review tool
	"cts",
	// Python
	"py",
	"pyi",
	"pyx",
	"pxd",
	// Ruby
	"rb",
	"erb",
	"rake",
	"gemspec",
	// Rust
	"rs",
	// Go
	"go",
	"mod",
	"sum",
	// Java / JVM
	"java",
	"kt",
	"kts",
	"scala",
	"sc",
	"groovy",
	"clj",
	"cljs",
	"edn",
	// C / C++
	"c",
	"h",
	"cpp",
	"cxx",
	"cc",
	"hpp",
	"hxx",
	"ino",
	// C#
	"cs",
	"csx",
	"vb",
	// Web
	"html",
	"htm",
	"xhtml",
	"css",
	"scss",
	"sass",
	"less",
	"vue",
	"svelte",
	"astro",
	// Shell / Build
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"psm1",
	"bat",
	"cmd",
	"mk",
	"make",
	"cmake",
	// Data / Config
	"json",
	"jsonc",
	"json5",
	"yaml",
	"yml",
	"toml",
	"ini",
	"conf",
	"config",
	"cfg",
	"env",
	"properties",
	"plist",
	"manifest",
	"rules",
	"prefs",
	"editorconfig",
	"eslintrc",
	"babelrc",
	"gitignore",
	"gitattributes",
	"gitmodules",
	"gitkeep",
	"dockerignore",
	"npmignore",
	"eslintignore",
	"prettierignore",
	"bazelignore",
	// Markup / Doc
	"md",
	"markdown",
	"rst",
	"tex",
	"txt",
	"text",
	"org",
	"adoc",
	"asciidoc",
	"wiki",
	"creole",
	"man",
	"pod",
	// Database
	"sql",
	"prisma",
	"graphql",
	"gql",
	"mongorc",
	// Other languages
	"php",
	"swift",
	"m",
	"mm",
	"r",
	"pl",
	"pm",
	"lua",
	"jl",
	"fs",
	"fsx",
	"fsi",
	"elm",
	"erl",
	"hrl",
	"ex",
	"exs",
	"hs",
	"lhs",
	"ml",
	"mli",
	"nim",
	"pas",
	"pp",
	"sol",
	"tcl",
	"v",
	"sv",
	"vhd",
	"vhdl",
	"zig",
	"wat",
	"wast",
	"cr",
	"d",
	"gd",
	"lisp",
	"lsp",
	"cl",
	"el",
	"vim",
	"nvim",
	// Log / Other
	"log",
	"csv",
	"tsv",
	"diff",
	"patch",
	"map",
	"mailmap",
	"nojekyll",
	"htaccess",
	"htpasswd",
	"robots",
	"sitemap",
	// Certificates / Keys
	"pem",
	"crt",
	"key",
	"csr",
	"p12",
	"asc",
	"sig",
	// Common license/changelog filenames (treated as extensions for files like LICENSE.txt)
	"license",
	"copying",
	"authors",
	"changelog",
	"changes",
	"news",
	"todo",
	"readme",
	"contributing",
	"codeowners",
	"security",
])

const BINARY_FILE_EXTENSIONS = new Set([
	// Images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"tiff",
	"tif",
	"webp",
	"ico",
	"svgz",
	"psd",
	"ai",
	"eps",
	"raw",
	"cr2",
	"nef",
	"dng",
	"heic",
	"heif",
	"avif",
	"jxr",
	"wdp",
	// Videos
	"mp4",
	"mov",
	"avi",
	"mkv",
	"wmv",
	"flv",
	"f4v",
	"webm",
	"m4v",
	"mpg",
	"mpeg",
	"3gp",
	"3g2",
	"mts",
	"m2ts",
	"vob",
	"ogv",
	// Audio
	"mp3",
	"wav",
	"aac",
	"flac",
	"ogg",
	"oga",
	"wma",
	"m4a",
	"aiff",
	"au",
	"opus",
	"weba",
	"mid",
	"midi",
	// Archives
	"zip",
	"tar",
	"gz",
	"bz2",
	"xz",
	"7z",
	"rar",
	"lz",
	"lzma",
	"z",
	"tgz",
	"tbz",
	"txz",
	"cab",
	"deb",
	"rpm",
	"dmg",
	"pkg",
	"msi",
	"apk",
	"ipa",
	"snap",
	"egg",
	"whl",
	// Executables / Binaries
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	"o",
	"a",
	"lib",
	"pdb",
	"elf",
	"class",
	"jar",
	"war",
	"ear",
	"nuget",
	"nupkg",
	"app",
	"msp",
	"msu",
	// Fonts
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	// Documents
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"odt",
	"ods",
	"odp",
	"rtf",
	"pub",
	"mdb",
	"accdb",
	// Other binary
	"db",
	"sqlite",
	"sqlite3",
	"db3",
	"s3db",
	"sl3",
	"wasm",
	"pyc",
	"pyo",
	"pyd",
	"obj",
	"pch",
	"ilk",
	"exp",
	"ko",
	"sys",
	"drv",
	"node",
	"bundle",
	// IDE / Editor
	"suo",
	"user",
	"ncb",
	"sdf",
	"opensdf",
	"opendb",
	"cache",
	// Game / 3D
	"fbx",
	"3ds",
	"dae",
	"blend",
	"max",
	"ma",
	"mb",
	"gltf",
	"glb",
	"usd",
	"usda",
	"usdc",
	"usdz",
	// Scientific / Data
	"mat",
	"h5",
	"hdf5",
	"nc",
	"fits",
	"pkl",
	"pickle",
	"parquet",
	"feather",
	"arrow",
	"orc",
	"avro",
	"msgpack",
	// Other
	"ttc",
	"dfont",
	"suit",
	"dat",
	"idx",
	"pack",
	"rev",
])

const TEXT_FILE_NAMES = new Set([
	"dockerfile",
	"jenkinsfile",
	"gemfile",
	"rakefile",
	"makefile",
])

function getExtension(filename: string): string {
	const dotIndex = filename.lastIndexOf(".")
	if (dotIndex < 0) return ""
	return filename.slice(dotIndex + 1).toLowerCase()
}

function isTextFile(filename: string): boolean {
	const basename = filename.split("/").pop()!
	const lowerBasename = basename.toLowerCase()
	if (TEXT_FILE_NAMES.has(lowerBasename)) return true

	const ext = getExtension(filename)
	if (TEXT_FILE_EXTENSIONS.has(ext)) return true
	if (BINARY_FILE_EXTENSIONS.has(ext)) return false
	// For files with no extension, also check against known text extensions
	if (ext === "" && TEXT_FILE_EXTENSIONS.has(lowerBasename)) return true
	// For dotfiles, check the name without the leading dot
	if (lowerBasename.startsWith(".") && TEXT_FILE_EXTENSIONS.has(lowerBasename.slice(1))) return true
	return false
}

export function createGetBaseCommitContext(spawnGit: SpawnGit): (baseCommit: string) => Promise<BaseCommitContext> {
	// Reads the entire repo into memory — not suitable for large monorepos
	return async function getBaseCommitContext(baseCommit: string): Promise<BaseCommitContext> {
		const lsTreeResult = await spawnGit(["ls-tree", "-r", "--name-only", baseCommit])
		if (lsTreeResult.exitCode !== 0) {
			throw new Error(`Failed to list files in base commit: ${lsTreeResult.stderr.trim()}`)
		}

		const allFiles = lsTreeResult.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0)

		const ignorePatterns: string[] = [".git/"]

		const gitignoreResult = await spawnGit(["ls-tree", baseCommit, "--", ".gitignore"])
		if (gitignoreResult.stdout.trim().length > 0) {
			const showResult = await spawnGit(["show", `${baseCommit}:.gitignore`])
			if (showResult.exitCode === 0) {
				ignorePatterns.push(...parseIgnorePatterns(showResult.stdout))
			}
		}

		const dockerignoreResult = await spawnGit(["ls-tree", baseCommit, "--", ".dockerignore"])
		if (dockerignoreResult.stdout.trim().length > 0) {
			const showResult = await spawnGit(["show", `${baseCommit}:.dockerignore`])
			if (showResult.exitCode === 0) {
				ignorePatterns.push(...parseIgnorePatterns(showResult.stdout))
			}
		}

		const fileList = allFiles.filter(file => !isPathIgnored(file, ignorePatterns))

		const fileContents = new Map<string, string>()
		for (const file of fileList) {
			if (!isTextFile(file)) continue

			const showResult = await spawnGit(["show", `${baseCommit}:${file}`])
			if (showResult.exitCode !== 0) {
				throw new Error(`Failed to read file ${file} at commit ${baseCommit}: ${showResult.stderr.trim()}`)
			}

			fileContents.set(file, showResult.stdout)
		}

		return { fileList, fileContents }
	}
}
