type Primitive = string | number | boolean | bigint | null | void | symbol | Function
// A debug type used to expand deep or messy types.
type Expand<T> = T extends Primitive ? T : { [K in keyof T]: Expand<T[K]> }

export function includes<S extends string>(haystack: readonly S[], needle: string): needle is S {
	return haystack.some(x => x === needle)
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled discriminant: ${value}`)
}

export function parseCommaSeparatedList(input: string): readonly string[] {
	return input.split(',').map(s => s.trim()).filter(s => s.length > 0)
}

// See: https://github.com/microsoft/TypeScript/issues/17002
export function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value)
}
export function isReadonlyArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object') return false
	if (value === null) return false
	if (isArray(value)) return false
	return true
}

export type Guard<T> = (value: unknown) => value is T
export interface OptionalMarker<T> {
	__optional: true
	guard: Guard<T>
}

type InferGuardType<G> = G extends Guard<infer T> ? T : G extends OptionalMarker<infer T> ? T : never
export type InferGuard<G> = G extends Guard<infer T> ? T : never
type SchemaValue = Guard<unknown> | OptionalMarker<unknown>
type InferSchemaType<S extends Record<string, SchemaValue>> = Expand<
	& { [K in keyof S as S[K] extends OptionalMarker<unknown> ? K : never]?: S[K] extends OptionalMarker<infer T> ? T : never }
	& { [K in keyof S as S[K] extends OptionalMarker<unknown> ? never : K]: InferGuardType<S[K]> }
>

function isOptionalMarker(value: SchemaValue): value is OptionalMarker<unknown> {
	return typeof value === 'object' && value !== null && '__optional' in value
}

export function isString(value: unknown): value is string {
	return typeof value === 'string'
}
export function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}
export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean'
}
export function isNull(value: unknown): value is null {
	return value === null
}
export function isUndefined(value: unknown): value is undefined {
	return value === undefined
}

export function isLiteral<T extends string | number | boolean>(literal: T): Guard<T> {
	return (value: unknown): value is T => value === literal
}

export function optional<T>(guard: Guard<T>): OptionalMarker<T> {
	return { __optional: true, guard }
}

export function isArrayOf<T>(itemGuard: Guard<T>): Guard<readonly T[]> {
	return (value: unknown): value is readonly T[] => {
		if (!isArray(value)) return false
		return value.every(item => itemGuard(item))
	}
}

export function guard<S extends Record<string, SchemaValue>>(schema: S): Guard<InferSchemaType<S>> {
	return (value: unknown): value is InferSchemaType<S> => isObjectOf(value, schema)
}

export function isObjectOf<S extends Record<string, SchemaValue>>(value: unknown, schema: S): value is InferSchemaType<S> {
	if (!isRecord(value)) return false
	for (const [key, keyGuardOrOptional] of Object.entries(schema)) {
		if (isOptionalMarker(keyGuardOrOptional)) {
			if (!(key in value)) continue
			if (!keyGuardOrOptional.guard(value[key])) return false
		} else {
			if (!(key in value)) return false
			if (!keyGuardOrOptional(value[key])) return false
		}
	}
	return true
}
