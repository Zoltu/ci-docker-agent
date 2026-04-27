export function parseIgnorePatterns(content: string): string[] {
	return content
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"))
		.map(line => {
			// Strip inline comments (unescaped # preceded by whitespace)
			const commentIndex = line.search(/(?<!\\)\s+#/)
			if (commentIndex !== -1) {
				line = line.slice(0, commentIndex).trimEnd()
			}
			// Unescape escaped hashes
			return line.replace(/\\#/g, "#")
		})
		.filter(line => line.length > 0)
}

export function isPathIgnored(path: string, patterns: string[]): boolean {
	const segments = path.split("/")

	let ignored = false
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			if (matchPattern(path, segments, pattern.slice(1))) {
				ignored = false
			}
		} else {
			if (matchPattern(path, segments, pattern)) {
				ignored = true
			}
		}
	}
	return ignored
}

function matchPattern(path: string, segments: string[], pattern: string): boolean {
	const directoryOnly = pattern.endsWith("/")
	const cleanPattern = directoryOnly ? pattern.slice(0, -1) : pattern
	// We only filter files, so directory-only patterns never match files
	if (directoryOnly) return false

	let searchPattern = cleanPattern
	let matchAnyDepth = false

	if (searchPattern.startsWith("**/")) {
		searchPattern = searchPattern.slice(3)
		matchAnyDepth = true
	}

	const anchored = searchPattern.startsWith("/")
	if (anchored) {
		searchPattern = searchPattern.slice(1)
		matchAnyDepth = false
	}

	if (!searchPattern.includes("/")) {
		// Matches any path segment
		if (matchAnyDepth || !anchored) {
			for (const segment of segments) {
				if (matchGlob(segment, searchPattern)) return true
			}
			return false
		}
		// Anchored to root
		return matchGlob(segments[0] ?? "", searchPattern)
	}

	// Contains / - must match full path
	if (matchAnyDepth) {
		const patternParts = searchPattern.split("/")
		const patternDepth = patternParts.length
		for (let start = 0; start <= segments.length - patternDepth; start++) {
			const subpath = segments.slice(start, start + patternDepth).join("/")
			if (matchGlob(subpath, searchPattern)) return true
		}
		return false
	}

	// Anchored or unanchored with / - for root-level .gitignore both match relative to root
	return matchGlob(path, searchPattern)
}

function matchGlob(text: string, pattern: string): boolean {
	let regexStr = ""
	let i = 0
	while (i < pattern.length) {
		const char = pattern[i]!
		if (char === "*") {
			if (i + 1 < pattern.length && pattern[i + 1] === "*") {
				regexStr += ".*"
				i += 2
			} else {
				regexStr += "[^/]*"
				i++
			}
		} else if (char === "?") {
			regexStr += "[^/]"
			i++
		} else if (char === "[") {
			const closeIndex = pattern.indexOf("]", i)
			if (closeIndex === -1) {
				regexStr += escapeRegex(char)
				i++
			} else {
				regexStr += pattern.slice(i, closeIndex + 1)
				i = closeIndex + 1
			}
		} else {
			regexStr += escapeRegex(char)
			i++
		}
	}
	const regex = new RegExp(`^${regexStr}$`)
	return regex.test(text)
}

function escapeRegex(char: string): string {
	const specials = /[.+^${}()|[\]\\]/
	return specials.test(char) ? "\\" + char : char
}
