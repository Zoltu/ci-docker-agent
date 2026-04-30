export const TEXT_FILE_EXTENSIONS = new Set([
	// JavaScript / TypeScript
	"js",
	"mjs",
	"cjs",
	"jsx",
	"ts",
	"tsx",
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

export const BINARY_FILE_EXTENSIONS = new Set([
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

export const AMBIGUOUS_FILE_EXTENSIONS = new Set([
	"mts", // TypeScript module or MPEG Transport Stream
])

const TEXT_FILE_NAMES = new Set([
	"dockerfile",
	"jenkinsfile",
	"gemfile",
	"rakefile",
	"makefile",
])

const CHECK_SIZE = 8192

function getExtension(filename: string): string {
	const dotIndex = filename.lastIndexOf(".")
	if (dotIndex < 0) return ""
	return filename.slice(dotIndex + 1).toLowerCase()
}

export type FileClassification = "text" | "binary" | "ambiguous"

export function classifyFileByExtension(filename: string): FileClassification {
	const basename = filename.split("/").pop()!
	const lowerBasename = basename.toLowerCase()
	if (TEXT_FILE_NAMES.has(lowerBasename)) return "text"

	const ext = getExtension(filename)
	if (AMBIGUOUS_FILE_EXTENSIONS.has(ext)) return "ambiguous"
	if (TEXT_FILE_EXTENSIONS.has(ext)) return "text"
	if (BINARY_FILE_EXTENSIONS.has(ext)) return "binary"
	if (ext === "" && TEXT_FILE_EXTENSIONS.has(lowerBasename)) return "text"
	if (lowerBasename.startsWith(".") && TEXT_FILE_EXTENSIONS.has(lowerBasename.slice(1))) return "text"
	return "binary"
}

export function isContentText(content: string): boolean {
	const sample = content.slice(0, CHECK_SIZE)
	if (sample.length === 0) return true

	if (sample.includes("\x00")) return false

	if (sample.includes("\uFFFD")) return false

	let printableCount = 0
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i)
		if (
			(code >= 0x20 && code <= 0x7E) ||
			code === 0x09 ||
			code === 0x0A ||
			code === 0x0D ||
			code > 0x7F
		) {
			printableCount++
		}
	}

	return printableCount / sample.length >= 0.85
}
