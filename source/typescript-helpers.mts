export function includes<S extends string>(haystack: readonly S[], needle: string): needle is S {
	return haystack.some(x => x === needle)
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled discriminant: ${value}`)
}
