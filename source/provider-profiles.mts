import type { CompletionsMessage, CompletionsRequest } from './completions.mts'
import { deepMerge } from './typescript-helpers.mts'

export interface ProviderProfile {
	readonly prepareRequest: (request: CompletionsRequest) => CompletionsRequest
	readonly overwritePaths: readonly (readonly string[])[]
	// Path through an assistant message to the field that carries the model's reasoning. The root field name also drives normalizeMessage's preferred field (see derivePreferredField). Non-empty: omit the field to use DEFAULT_REASONING_PATH instead.
	readonly reasoningField?: readonly [string, ...string[]]
	// Normalizes an accumulated assistant message. Must resolve the reasoning/reasoning_content
	// overlap (keep exactly one) when both are present — completeAccumulation fails fast if both survive.
	readonly normalizeMessage: (message: Record<string, unknown>) => void
}

// Must match the default reasoning field path used when no profile specifies one.
export const DEFAULT_REASONING_PATH = ["reasoning"] as const

// Normalizes the reasoning/reasoning_content pair on an assistant message down to a single field,
// keeping preferredField unless it is an empty stub.
function createReasoningNormalizer(preferredField: "reasoning" | "reasoning_content"): (message: Record<string, unknown>) => void {
	return (message) => {
		if (message.reasoning === undefined || message.reasoning_content === undefined) return
		const reasoningEmpty = message.reasoning === null || message.reasoning === ""
		const reasoningContentEmpty = message.reasoning_content === null || message.reasoning_content === ""
		if (!reasoningEmpty && !reasoningContentEmpty && message.reasoning !== message.reasoning_content) {
			throw new Error(`Assistant message has both reasoning and reasoning_content with different values. reasoning: ${JSON.stringify(message.reasoning)}, reasoning_content: ${JSON.stringify(message.reasoning_content)}`)
		}
		const preferReasoningContent = preferredField === "reasoning_content"
		let keepReasoningContent = preferReasoningContent
		if (preferReasoningContent && reasoningContentEmpty && !reasoningEmpty) {
			keepReasoningContent = false
		} else if (!preferReasoningContent && reasoningEmpty && !reasoningContentEmpty) {
			keepReasoningContent = true
		}
		if (keepReasoningContent) {
			delete message.reasoning
		} else {
			delete message.reasoning_content
		}
	}
}

function derivePreferredField(reasoningField?: readonly [string, ...string[]]): "reasoning" | "reasoning_content" {
	return reasoningField?.[0] === "reasoning_content" ? "reasoning_content" : DEFAULT_REASONING_PATH[0]
}

interface ProfileConfig {
	readonly prepareRequest: (request: CompletionsRequest) => CompletionsRequest
	readonly overwritePaths: readonly (readonly string[])[]
	readonly reasoningField?: readonly [string, ...string[]]
}

export function createProfile(config: ProfileConfig): ProviderProfile {
	return {
		prepareRequest: config.prepareRequest,
		overwritePaths: config.overwritePaths,
		reasoningField: config.reasoningField,
		normalizeMessage: createReasoningNormalizer(derivePreferredField(config.reasoningField)),
	}
}

export const IDENTITY_PROFILE: ProviderProfile = createProfile({
	prepareRequest: request => request,
	overwritePaths: [],
})

function moveReasoningToReasoningContent(messages: readonly CompletionsMessage[]): CompletionsMessage[] {
	return messages.map(message => {
		if (message.role !== 'assistant') return message
		if (!('reasoning' in message)) return message
		if (message.reasoning === undefined) return message
		const { reasoning, ...rest } = message
		return { ...rest, reasoning_content: reasoning }
	})
}

export const TOGETHER_AI_PROFILE: ProviderProfile = createProfile({
	prepareRequest: request => ({ ...request, messages: moveReasoningToReasoningContent(request.messages) }),
	overwritePaths: [
		["role"],
		["tool_calls", "type"],
	],
})

export const PPQ_AI_PROFILE: ProviderProfile = createProfile({
	prepareRequest: request => request,
	overwritePaths: [
		["role"],
		["reasoning_details", "type"],
		["reasoning_details", "format"],
	],
})

export const QWEN_PROFILE: ProviderProfile = createProfile({
	prepareRequest: request => ({ ...request, chat_template_kwargs: { preserve_thinking: true } }),
	overwritePaths: [],
	reasoningField: ["reasoning_content"],
})

export const KIMI_PROFILE: ProviderProfile = createProfile({
	prepareRequest: request => ({ ...request, chat_template_kwargs: { preserve_thinking: true } }),
	overwritePaths: [],
	reasoningField: ["reasoning_content"],
})

export const GLM_PROFILE: ProviderProfile = createProfile({
	prepareRequest: request => ({ ...request, chat_template_kwargs: { clear_thinking: false } }),
	overwritePaths: [],
	reasoningField: ["reasoning_content"],
})

const PROVIDER_HOSTNAMES: Record<string, string> = {
	'api.together.ai': 'together-ai',
	'api.ppq.ai': 'ppq-ai',
}

const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
	'together-ai': TOGETHER_AI_PROFILE,
	'ppq-ai': PPQ_AI_PROFILE,
}

// Pattern order matters only as a tiebreaker when multiple patterns have the same length and both match.
const MODEL_PATTERNS: ReadonlyArray<{ readonly pattern: string, readonly profile: ProviderProfile }> = [
	{ pattern: 'qwen', profile: QWEN_PROFILE },
	{ pattern: 'kimi', profile: KIMI_PROFILE },
	{ pattern: 'glm', profile: GLM_PROFILE },
]

const EXACT_PROFILES: Record<string, ProviderProfile> = {}

function getHostname(apiUrl: string): string | null {
	if (!URL.canParse(apiUrl)) return null
	return new URL(apiUrl).hostname
}

// Returns true if every character of `query` appears in `target` in order (case-insensitive, non-contiguous).
export function isSubsequence(query: string, target: string): boolean {
	if (query.length === 0) return true
	const queryLower = query.toLowerCase()
	const targetLower = target.toLowerCase()
	let q = 0
	for (let t = 0; t < targetLower.length; t++) {
		if (queryLower[q] === targetLower[t]) q++
		if (q === queryLower.length) return true
	}
	return false
}

function findLongestMatchingModelProfile(model: string): ProviderProfile | null {
	let best: { pattern: string, profile: ProviderProfile } | null = null
	for (const entry of MODEL_PATTERNS) {
		if (!isSubsequence(entry.pattern, model)) continue
		if (best === null || entry.pattern.length > best.pattern.length) {
			best = entry
		}
	}
	return best?.profile ?? null
}

// Each profile transforms the original request independently, then results are deep-merged so nested objects (e.g. chat_template_kwargs) are unioned instead of clobbered. The provider wins on scalar conflicts.
function composeProfiles(first: ProviderProfile, second: ProviderProfile): ProviderProfile {
	const mergedReasoningField: readonly [string, ...string[]] | undefined = second.reasoningField ?? first.reasoningField
	// createProfile derives normalizeMessage from the merged reasoningField so the two halves
	// of the field-naming policy cannot disagree in a composed profile.
	return createProfile({
		prepareRequest: (request) => {
			const fromFirst = first.prepareRequest(request)
			const fromSecond = second.prepareRequest(request)
			return deepMerge(fromFirst, fromSecond)
		},
		overwritePaths: [...first.overwritePaths, ...second.overwritePaths],
		reasoningField: mergedReasoningField,
	})
}

export function selectProviderProfile(apiUrl: string, model: string): ProviderProfile {
	const hostname = getHostname(apiUrl)
	const providerKey = hostname !== null ? PROVIDER_HOSTNAMES[hostname] ?? null : null

	if (providerKey !== null) {
		const exactProfile = EXACT_PROFILES[`${providerKey}:${model}`]
		if (exactProfile) return exactProfile
	}

	const providerProfile = providerKey !== null ? PROVIDER_PROFILES[providerKey] ?? null : null
	const modelProfile = findLongestMatchingModelProfile(model)

	if (providerProfile && modelProfile) return composeProfiles(modelProfile, providerProfile)
	if (providerProfile) return providerProfile
	if (modelProfile) return modelProfile
	return IDENTITY_PROFILE
}
