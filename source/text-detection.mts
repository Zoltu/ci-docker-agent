const COMMON_BINARY_FILE_EXTENSIONS = new Set([ "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "mp3", "wav", "aac", "flac", "ogg", "m4a", "mp4", "mov", "avi", "mkv", "webm", "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "exe", "dll", "so", "dylib", "bin", "class", "jar", "node", "wasm", "o", "woff", "woff2", "ttf", "otf", "eot", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "db", "sqlite", "sqlite3", "pyc" ])

function getExtension(filename: string): string {
	const dotIndex = filename.lastIndexOf(".")
	if (dotIndex < 0) return ""
	return filename.slice(dotIndex + 1).toLowerCase()
}

export function isBinaryExtension(filename: string): boolean {
	return COMMON_BINARY_FILE_EXTENSIONS.has(getExtension(filename))
}

const CHECK_SIZE = 8192

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
