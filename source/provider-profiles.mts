import type { CompletionsMessage, CompletionsRequest } from './completions.mts'
import { deepMerge } from './typescript-helpers.mts'

// Path through an assistant message to the field that carries the model's reasoning. Defaults to ["reasoning"] in the agent loop.
// Numeric segments index into arrays (e.g. ["reasoning_details", "0", "text"]); non-numeric segments index into objects.
export interface ProviderProfile {
	readonly prepareRequest: (request: CompletionsRequest) => CompletionsRequest
	readonly overwritePaths: readonly (readonly string[])[]
	readonly reasoningField?: readonly string[]
}

export const IDENTITY_PROFILE: ProviderProfile = {
	prepareRequest: request => request,
	overwritePaths: [],
}

function moveReasoningToReasoningContent(messages: readonly CompletionsMessage[]): CompletionsMessage[] {
	return messages.map(message => {
		if (message.role !== 'assistant') return message
		if (!('reasoning' in message)) return message
		if (message.reasoning === undefined) return message
		const { reasoning, ...rest } = message
		return { ...rest, reasoning_content: reasoning }
	})
}

export const TOGETHER_AI_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, messages: moveReasoningToReasoningContent(request.messages) }),
	overwritePaths: [
		['role'],
		['tool_calls', 'type'],
	],
}

export const PPQ_AI_PROFILE: ProviderProfile = {
	prepareRequest: request => request,
	overwritePaths: [
		['role'],
		['reasoning_details', 'type'],
		['reasoning_details', 'format'],
	],
}

export const QWEN_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, chat_template_kwargs: { preserve_thinking: true } }),
	overwritePaths: [],
	reasoningField: ["reasoning_content"],
}

export const KIMI_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, chat_template_kwargs: { preserve_thinking: true } }),
	overwritePaths: [],
	reasoningField: ["reasoning_content"],
}

export const GLM_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, chat_template_kwargs: { clear_thinking: false } }),
	overwritePaths: [],
	reasoningField: ["reasoning_content"],
}

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
	try {
		return new URL(apiUrl).hostname
	} catch {
		return null
	}
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
	return {
		prepareRequest: (request) => {
			const fromFirst = first.prepareRequest(request)
			const fromSecond = second.prepareRequest(request)
			return deepMerge(fromFirst, fromSecond)
		},
		overwritePaths: [...first.overwritePaths, ...second.overwritePaths],
		reasoningField: second.reasoningField ?? first.reasoningField,
	}
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
