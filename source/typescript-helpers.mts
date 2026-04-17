export function includes<S extends string>(haystack: readonly S[], needle: string): needle is S {
	return haystack.some(x => x === needle)
}
