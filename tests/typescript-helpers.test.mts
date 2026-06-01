import { describe, expect, it } from "bun:test"
import { assertNever, guard, includes, isArray, isArrayOf, isBoolean, isInteger, isLiteral, isNull, isNumber, isObjectOf, isReadonlyArray, isRecord, isString, isUndefined, optional, parseCommaSeparatedList, sleepWithSignal, type Guard } from "../source/typescript-helpers.mts"

describe("includes", () => {
	it("returns true when needle is in haystack", () => {
		expect(includes(["a", "b", "c"], "b")).toBe(true)
	})

	it("returns false when needle is not in haystack", () => {
		expect(includes(["a", "b", "c"], "d")).toBe(false)
	})

	it("narrows the type when true", () => {
		const values: readonly ["x", "y"] = ["x", "y"]
		const needle: string = "x"
		if (includes(values, needle)) {
			const _narrowed: "x" | "y" = needle
			expect(_narrowed).toBe("x")
		}
	})
})

describe("assertNever", () => {
	it("throws an error", () => {
		// @ts-expect-error - intentionally passing a non-never value to test runtime behavior
		expect(() => assertNever("something")).toThrow("Unhandled discriminant: something")
	})
})

describe("parseCommaSeparatedList", () => {
	it("splits on commas and trims whitespace", () => {
		expect(parseCommaSeparatedList("a, b , c")).toEqual(["a", "b", "c"])
	})

	it("filters out empty segments", () => {
		expect(parseCommaSeparatedList("a,,b,")).toEqual(["a", "b"])
	})

	it("returns empty array for empty string", () => {
		expect(parseCommaSeparatedList("")).toEqual([])
	})

	it("returns empty array for whitespace-only string", () => {
		expect(parseCommaSeparatedList("   ")).toEqual([])
	})

	it("handles single item", () => {
		expect(parseCommaSeparatedList("hello")).toEqual(["hello"])
	})
})

describe("isArray", () => {
	it("returns true for arrays", () => {
		expect(isArray([1, 2, 3])).toBe(true)
	})

	it("returns false for non-arrays", () => {
		expect(isArray("not array")).toBe(false)
		expect(isArray(42)).toBe(false)
		expect(isArray(null)).toBe(false)
		expect(isArray({})).toBe(false)
	})
})

describe("isReadonlyArray", () => {
	it("returns true for arrays", () => {
		expect(isReadonlyArray([1, 2, 3])).toBe(true)
	})

	it("returns false for non-arrays", () => {
		expect(isReadonlyArray({})).toBe(false)
	})
})

describe("isRecord", () => {
	it("returns true for plain objects", () => {
		expect(isRecord({ a: 1 })).toBe(true)
	})

	it("returns false for null", () => {
		expect(isRecord(null)).toBe(false)
	})

	it("returns false for arrays", () => {
		expect(isRecord([1, 2])).toBe(false)
	})

	it("returns false for primitives", () => {
		expect(isRecord("string")).toBe(false)
		expect(isRecord(42)).toBe(false)
		expect(isRecord(true)).toBe(false)
		expect(isRecord(undefined)).toBe(false)
	})
})

describe("isString", () => {
	it("returns true for strings", () => {
		expect(isString("hello")).toBe(true)
	})
	it("returns false for non-strings", () => {
		expect(isString(42)).toBe(false)
		expect(isString(true)).toBe(false)
		expect(isString(null)).toBe(false)
		expect(isString(undefined)).toBe(false)
		expect(isString({})).toBe(false)
	})
})

describe("isNumber", () => {
	it("returns true for numbers", () => {
		expect(isNumber(42)).toBe(true)
		expect(isNumber(0)).toBe(true)
	})
	it("returns false for NaN and Infinity", () => {
		expect(isNumber(NaN)).toBe(false)
		expect(isNumber(Infinity)).toBe(false)
		expect(isNumber(-Infinity)).toBe(false)
	})
	it("returns false for non-numbers", () => {
		expect(isNumber("42")).toBe(false)
		expect(isNumber(true)).toBe(false)
		expect(isNumber(null)).toBe(false)
		expect(isNumber(undefined)).toBe(false)
	})
})

describe("isInteger", () => {
	it("returns true for integers", () => {
		expect(isInteger(42)).toBe(true)
		expect(isInteger(0)).toBe(true)
		expect(isInteger(-1)).toBe(true)
	})
	it("returns false for non-integers", () => {
		expect(isInteger(3.14)).toBe(false)
		expect(isInteger(NaN)).toBe(false)
		expect(isInteger(Infinity)).toBe(false)
		expect(isInteger(-Infinity)).toBe(false)
	})
	it("returns false for non-numbers", () => {
		expect(isInteger("42")).toBe(false)
		expect(isInteger(true)).toBe(false)
		expect(isInteger(null)).toBe(false)
		expect(isInteger(undefined)).toBe(false)
	})
})

describe("isBoolean", () => {
	it("returns true for booleans", () => {
		expect(isBoolean(true)).toBe(true)
		expect(isBoolean(false)).toBe(true)
	})
	it("returns false for non-booleans", () => {
		expect(isBoolean(0)).toBe(false)
		expect(isBoolean("true")).toBe(false)
		expect(isBoolean(null)).toBe(false)
		expect(isBoolean(undefined)).toBe(false)
	})
})

describe("isNull", () => {
	it("returns true for null", () => {
		expect(isNull(null)).toBe(true)
	})
	it("returns false for non-null", () => {
		expect(isNull(undefined)).toBe(false)
		expect(isNull(0)).toBe(false)
		expect(isNull("")).toBe(false)
	})
})

describe("isUndefined", () => {
	it("returns true for undefined", () => {
		expect(isUndefined(undefined)).toBe(true)
	})
	it("returns false for non-undefined", () => {
		expect(isUndefined(null)).toBe(false)
		expect(isUndefined(0)).toBe(false)
		expect(isUndefined("")).toBe(false)
	})
})

describe("isArrayOf", () => {
	const isStringArray = isArrayOf(isString)
	const isNumberArray = isArrayOf(isNumber)

	it("returns true when all items match the guard", () => {
		expect(isStringArray(["a", "b", "c"])).toBe(true)
		expect(isNumberArray([1, 2, 3])).toBe(true)
	})
	it("returns true for empty arrays", () => {
		expect(isStringArray([])).toBe(true)
	})
	it("returns false when any item fails the guard", () => {
		expect(isStringArray(["a", 1, "c"])).toBe(false)
		expect(isNumberArray([1, "2", 3])).toBe(false)
	})
	it("returns false for non-arrays", () => {
		expect(isStringArray("not an array")).toBe(false)
		expect(isStringArray({})).toBe(false)
		expect(isStringArray(null)).toBe(false)
		expect(isStringArray(undefined)).toBe(false)
	})
	it("narrows the type when true", () => {
		const value: unknown = ["a", "b"]
		if (isStringArray(value)) {
			const _narrowed: readonly string[] = value
			expect(_narrowed).toEqual(["a", "b"])
		}
	})
})

describe("guard", () => {
	const isPoint = guard({ x: isNumber, y: isNumber })

	it("returns a guard function that validates against the schema", () => {
		expect(isPoint({ x: 1, y: 2 })).toBe(true)
	})
	it("returns false when a property fails its guard", () => {
		expect(isPoint({ x: 1, y: "two" })).toBe(false)
	})
	it("returns false when a property is missing", () => {
		expect(isPoint({ x: 1 })).toBe(false)
	})
	it("returns true when object has extra properties", () => {
		expect(isPoint({ x: 1, y: 2, z: 3 })).toBe(true)
	})
	it("returns false for non-objects", () => {
		expect(isPoint(null)).toBe(false)
		expect(isPoint("string")).toBe(false)
		expect(isPoint(42)).toBe(false)
	})
	it("returns false for arrays", () => {
		expect(isPoint([1, 2])).toBe(false)
	})
	it("narrows the type when true", () => {
		const value: unknown = { x: 1, y: 2 }
		if (isPoint(value)) {
			const _narrowed: { x: number; y: number } = value
			expect(_narrowed.x).toBe(1)
		}
	})
	it("works recursively with nested guard()", () => {
		const isInner = guard({ name: isString })
		const isOuter = guard({ inner: isInner })
		expect(isOuter({ inner: { name: "test" } })).toBe(true)
		expect(isOuter({ inner: { name: 42 } })).toBe(false)
		expect(isOuter({ inner: {} })).toBe(false)
		expect(isOuter({})).toBe(false)
	})
	it("works recursively with isObjectOf nesting", () => {
		const isInner = guard({ name: isString })
		expect(isObjectOf({ outer: { name: "test" } }, { outer: isInner })).toBe(true)
		expect(isObjectOf({ outer: { name: 42 } }, { outer: isInner })).toBe(false)
	})
})

describe("isObjectOf", () => {
	it("returns true when all properties match their guards", () => {
		expect(isObjectOf({ name: "alice", age: 30 }, { name: isString, age: isNumber })).toBe(true)
	})
	it("returns false when a property fails its guard", () => {
		expect(isObjectOf({ name: "alice", age: "30" }, { name: isString, age: isNumber })).toBe(false)
	})
	it("returns false when a property is missing", () => {
		expect(isObjectOf({ name: "alice" }, { name: isString, age: isNumber })).toBe(false)
	})
	it("returns true when object has extra properties", () => {
		expect(isObjectOf({ name: "alice", extra: true }, { name: isString })).toBe(true)
	})
	it("returns true for empty schema on a plain object", () => {
		expect(isObjectOf({}, {})).toBe(true)
	})
	it("returns false for null", () => {
		expect(isObjectOf(null, { x: isNumber })).toBe(false)
	})
	it("returns false for arrays", () => {
		expect(isObjectOf([1], { "0": isNumber })).toBe(false)
	})
	it("returns false for primitives", () => {
		expect(isObjectOf("string", { length: isNumber })).toBe(false)
		expect(isObjectOf(42, { x: isNumber })).toBe(false)
		expect(isObjectOf(true, { x: isNumber })).toBe(false)
		expect(isObjectOf(undefined, { x: isNumber })).toBe(false)
	})
	it("narrows the type when true", () => {
		const value: unknown = { name: "alice", age: 30 }
		if (isObjectOf(value, { name: isString, age: isNumber })) {
			const _narrowed: { name: string; age: number } = value
			expect(_narrowed.name).toBe("alice")
			expect(_narrowed.age).toBe(30)
		}
	})
	it("works with isArrayOf for nested array properties", () => {
		const schema = { items: isArrayOf(isString), count: isNumber }
		expect(isObjectOf({ items: ["a", "b"], count: 2 }, schema)).toBe(true)
		expect(isObjectOf({ items: ["a", 1], count: 2 }, schema)).toBe(false)
		expect(isObjectOf({ items: "not array", count: 2 }, schema)).toBe(false)
	})
	it("works with deep nesting via guard()", () => {
		const isAddress = guard({ city: isString, zip: isNumber })
		const isPerson = guard({ name: isString, address: isAddress })
		const valid = { name: "alice", address: { city: "NYC", zip: 10001 } }
		const invalidCity = { name: "alice", address: { city: 42, zip: 10001 } }
		const missingZip = { name: "alice", address: { city: "NYC" } }
		expect(isPerson(valid)).toBe(true)
		expect(isPerson(invalidCity)).toBe(false)
		expect(isPerson(missingZip)).toBe(false)
	})
	it("works with nullable guards via union", () => {
		const isStringOrNull: Guard<string | null> = (v): v is string | null => isString(v) || isNull(v)
		expect(isObjectOf({ name: "alice" }, { name: isStringOrNull })).toBe(true)
		expect(isObjectOf({ name: null }, { name: isStringOrNull })).toBe(true)
		expect(isObjectOf({ name: 42 }, { name: isStringOrNull })).toBe(false)
	})
})

describe("isLiteral", () => {
	const isFoo = isLiteral("foo")
	const is42 = isLiteral(42)
	const isTrue = isLiteral(true)

	it("returns true for matching string literal", () => {
		expect(isFoo("foo")).toBe(true)
	})
	it("returns false for non-matching string", () => {
		expect(isFoo("bar")).toBe(false)
	})
	it("returns false for non-string", () => {
		expect(isFoo(42)).toBe(false)
		expect(isFoo(null)).toBe(false)
	})
	it("returns true for matching number literal", () => {
		expect(is42(42)).toBe(true)
	})
	it("returns false for non-matching number", () => {
		expect(is42(0)).toBe(false)
	})
	it("returns true for matching boolean literal", () => {
		expect(isTrue(true)).toBe(true)
	})
	it("returns false for non-matching boolean", () => {
		expect(isTrue(false)).toBe(false)
	})
	it("narrows to the literal type", () => {
		const value: unknown = "foo"
		if (isFoo(value)) {
			const _narrowed: "foo" = value
			expect(_narrowed).toBe("foo")
		}
	})
})

describe("optional", () => {
	it("marks a property as optional in a guard schema", () => {
		const isPartialPoint = guard({ x: isNumber, y: optional(isNumber) })
		expect(isPartialPoint({ x: 1, y: 2 })).toBe(true)
		expect(isPartialPoint({ x: 1 })).toBe(true)
		expect(isPartialPoint({ x: 1, y: "two" })).toBe(false)
		expect(isPartialPoint({})).toBe(false)
	})
	it("optional property is typed as T | undefined", () => {
		const isPartialPoint = guard({ x: isNumber, y: optional(isNumber) })
		const value: unknown = { x: 1 }
		if (isPartialPoint(value)) {
			expect(value.x).toBe(1)
			expect(value.y).toBeUndefined()
		}
	})
	it("works with nested optional objects", () => {
		const isConfig = guard({
			name: isString,
			options: optional(guard({ verbose: isBoolean })),
		})
		expect(isConfig({ name: "test", options: { verbose: true } })).toBe(true)
		expect(isConfig({ name: "test" })).toBe(true)
		expect(isConfig({ name: "test", options: { verbose: "yes" } })).toBe(false)
		expect(isConfig({ name: "test", options: null })).toBe(true)
	})
	it("combines with isLiteral for discriminated unions", () => {
		const isEvent = guard({
			type: isLiteral("click"),
			x: optional(isNumber),
			y: optional(isNumber),
		})
		expect(isEvent({ type: "click", x: 1, y: 2 })).toBe(true)
		expect(isEvent({ type: "click" })).toBe(true)
		expect(isEvent({ type: "keypress", x: 1 })).toBe(false)
	})
})

describe("sleepWithSignal", () => {
	it("resolves after the specified duration", async () => {
		await sleepWithSignal(1, AbortSignal.timeout(100))
	})

	it("throws Error when signal is already aborted", () => {
		const controller = new AbortController()
		controller.abort()
		expect(sleepWithSignal(1, controller.signal)).rejects.toThrow("The operation was aborted.")
	})

	it("throws Error when signal fires during sleep", async () => {
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 1)
		expect(sleepWithSignal(60000, controller.signal)).rejects.toThrow("The operation was aborted.")
	}, { timeout: 100 })
})
