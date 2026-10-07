import type { CompletionsMessage, CompletionsRequest } from './completions.mts'
import { pickReasoningField } from './reasoning-overlap.mts'
import { deepMerge } from './typescript-helpers.mts'

export interface ProviderProfile {
	readonly prepareRequest: (request: CompletionsRequest) => CompletionsRequest
	// Path-specific merge overrides (exact path match → overwrite instead of concatenate).
	// Note: ONE_SHOT_KEYS in completions.mts supersedes this for role/id/type/name at any depth.
	// This field handles remaining cases (e.g. ['reasoning_details', 'format']).
	readonly overwritePaths: readonly (readonly string[])[]
	// Path through an assistant message to the field that carries the model's reasoning.
	// Numeric segments index into arrays (e.g. ["reasoning_details", "0", "text"]); non-numeric segments index into objects.
	//
	// This field also determines which of reasoning/reasoning_content normalization prefers when
	// both are present in an accumulated message. The rule: if the root segment is "reasoning_content",
	// prefer that field; all other paths (including nested paths like ["reasoning_details", "0", "text"])
	// prefer "reasoning". This derivation ensures the extraction path and normalization preference
	// cannot disagree. A nested-path profile gets the "reasoning" preference as a consequence.
	readonly reasoningField?: readonly [string, ...string[]]
}

export const IDENTITY_PROFILE: ProviderProfile = {
	prepareRequest: request => request,
	overwritePaths: [],
}

function moveReasoningToReasoningContent(messages: readonly CompletionsMessage[]): CompletionsMessage[] {
	return messages.map(message => {
		if (message.role !== 'assistant') return message
		const winner = pickReasoningField(message.reasoning, message.reasoning_content, 'reasoning_content')
		// Nothing to move: without `reasoning`, `reasoning_content` (if any) is already in place.
		if (!('reasoning' in message)) return message
		const { reasoning, ...rest } = message
		// `reasoning_content` won the overlap: drop `reasoning`; the winner already rides along in `rest`.
		if (winner === 'reasoning_content') return rest
		if (reasoning === undefined) return message
		// `reasoning` won (or stood alone): carry it under Together's `reasoning_content`, overwriting the
		// losing stub that `rest` still holds.
		return { ...rest, reasoning_content: reasoning }
	})
}

export const TOGETHER_AI_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, messages: moveReasoningToReasoningContent(request.messages) }),
	overwritePaths: [],
}

export const PPQ_AI_PROFILE: ProviderProfile = {
	prepareRequest: request => request,
	overwritePaths: [
		['reasoning_details', 'format'],
	],
}

export const QWEN_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, chat_template_kwargs: { preserve_thinking: true } }),
	overwritePaths: [],
	reasoningField: ['reasoning_content'],
}

export const KIMI_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, chat_template_kwargs: { preserve_thinking: true } }),
	overwritePaths: [],
	reasoningField: ['reasoning_content'],
}

export const GLM_PROFILE: ProviderProfile = {
	prepareRequest: request => ({ ...request, chat_template_kwargs: { clear_thinking: false } }),
	overwritePaths: [],
	reasoningField: ['reasoning_content'],
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

function getHostname(apiUrl: string): string | null {
	if (!URL.canParse(apiUrl)) return null
	return new URL(apiUrl).hostname
}

function matchesModelPattern(pattern: string, model: string): boolean {
	return model.toLowerCase().includes(pattern.toLowerCase())
}

function findLongestMatchingModelProfile(model: string): ProviderProfile | null {
	let best: { pattern: string, profile: ProviderProfile } | null = null
	for (const entry of MODEL_PATTERNS) {
		if (!matchesModelPattern(entry.pattern, model)) continue
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
	// Object.hasOwn keeps lookups off the prototype chain: plain-object indexing would resolve inherited keys like "constructor".
	const providerKey = hostname !== null && Object.hasOwn(PROVIDER_HOSTNAMES, hostname) ? PROVIDER_HOSTNAMES[hostname] ?? null : null
	const providerProfile = providerKey !== null && Object.hasOwn(PROVIDER_PROFILES, providerKey) ? PROVIDER_PROFILES[providerKey] ?? null : null
	const modelProfile = findLongestMatchingModelProfile(model)

	if (providerProfile && modelProfile) return composeProfiles(modelProfile, providerProfile)
	if (providerProfile) return providerProfile
	if (modelProfile) return modelProfile
	return IDENTITY_PROFILE
}
