import { requestUrl, RequestUrlResponse } from 'obsidian';

export const DEFAULT_API_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_API_KEY = 'ollama';
export const DEFAULT_MODEL = 'nemotron-3-super:cloud';
export const DEFAULT_REPHRASE_PROMPT = `You rephrase selected text inside a note.

Return the requested number of alternatives.
Each alternative must be a direct replacement for the selected text.
Rewrite only the text inside <selected_text>.
Use context only to preserve voice and meaning.
Preserve the meaning.
Preserve the writer's voice.
Do not add new facts.
Do not answer questions in the text.
Do not summarize the note.
Do not return the note title, date, surrounding context, or a plan.
Do not explain.
Return JSON only.
Do not include markdown or code fences.`;

const REPHRASE_MAX_TOKENS = 900;
const DEFAULT_REPHRASE_COUNT = 1;
const MIN_REPHRASE_COUNT = 1;
const MAX_REPHRASE_COUNT = 5;
const OLLAMA_CLOUD_API_BASE_URL = 'https://ollama.com/api';
const OPENROUTER_MODEL_CATALOG_URL =
	'https://openrouter.ai/api/v1/models?sort=newest&output_modalities=text';
const RECENT_MODEL_MAX_AGE_MONTHS = 6;

export interface ChatCompletionsSettings {
	apiBaseUrl: string;
	apiKey: string;
	model: string;
	rephrasePrompt: string;
}

export interface ChatModel {
	id: string;
	name: string;
	created?: number;
	ownedBy?: string;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
export const OPENAI_RECOMMENDED_MODELS: ChatModel[] = [
	{
		id: 'gpt-5.4-mini',
		name: 'gpt-5.4-mini - Recommended',
		ownedBy: 'openai',
	},
	{
		id: 'gpt-5.4-nano',
		name: 'gpt-5.4-nano - Fastest / lowest cost',
		ownedBy: 'openai',
	},
	{
		id: 'gpt-5.5',
		name: 'gpt-5.5 - Highest quality',
		ownedBy: 'openai',
	},
];

export interface ConnectionTestResult {
	modelCount: number;
	configuredModelListed: boolean;
}

export interface RephraseInput {
	noteTitle: string;
	before: string;
	selectedText: string;
	after: string;
}

export interface RephraseOptions {
	count?: number;
	avoidAlternatives?: string[];
}

export interface RephraseResult {
	alternatives: string[];
	metrics: {
		totalDuration?: number;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
	};
}

type TokenLimitParameter = 'max_tokens' | 'max_completion_tokens';

interface RephraseRequestOptions {
	includeResponseFormat: boolean;
	includeReasoningDisabled: boolean;
	includeTemperature: boolean;
	tokenLimitParameter: TokenLimitParameter;
}

export class RephraseApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RephraseApiError';
	}
}

export function getRephraseApiErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return 'Rephrase request failed.';
}

export class ChatCompletionsClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly rephrasePrompt: string;

	constructor(settings: ChatCompletionsSettings) {
		this.baseUrl = normalizeApiBaseUrl(settings.apiBaseUrl);
		this.apiKey = settings.apiKey.trim();
		this.model = settings.model.trim() || DEFAULT_MODEL;
		this.rephrasePrompt =
			settings.rephrasePrompt.trim() || DEFAULT_REPHRASE_PROMPT;
	}

	async listModels(): Promise<ChatModel[]> {
		if (isOpenRouterBaseUrl(this.baseUrl)) {
			return this.listRecentOpenRouterModels();
		}

		if (isOpenAiBaseUrl(this.baseUrl)) {
			return this.listAvailableOpenAiRecommendedModels();
		}

		let openAiError: unknown;

		try {
			const models = await this.listOpenAiModels();
			if (isOllamaCloudOpenAiBaseUrl(this.baseUrl)) {
				return filterRecentModels(models);
			}

			if (models.length > 0 || !isOllamaBaseUrl(this.baseUrl)) {
				return await this.withRecentOllamaCloudModels(models);
			}
		} catch (error) {
			if (!isOllamaBaseUrl(this.baseUrl)) {
				throw error;
			}

			openAiError = error;
		}

		try {
			return await this.withRecentOllamaCloudModels(
				await this.listOllamaNativeModels(),
			);
		} catch {
			if (openAiError instanceof Error) {
				throw openAiError;
			}

			throw new RephraseApiError('The API returned an unexpected model list.');
		}
	}

	private async withRecentOllamaCloudModels(
		models: ChatModel[],
	): Promise<ChatModel[]> {
		if (!isOllamaBaseUrl(this.baseUrl)) {
			return models;
		}

		try {
			return uniqueModels([
				...models,
				...(await this.listRecentOllamaCloudModelsForLocalOllama()),
			]);
		} catch (error) {
			console.warn('[RephraseThis] Failed to load Ollama cloud model catalog', error);
			return models;
		}
	}

	private async listOpenAiModels(): Promise<ChatModel[]> {
		const response = await this.request('GET', 'models');
		this.ensureOk(response);

		const payload = parseJson(response.text);
		return parseOpenAiModelList(payload);
	}

	private async listAvailableOpenAiRecommendedModels(): Promise<ChatModel[]> {
		const availableModels = await this.listOpenAiModels();
		const availableById = new Map(
			availableModels.map((model) => [model.id, model]),
		);
		const recommendedModels = OPENAI_RECOMMENDED_MODELS.filter((model) =>
			availableById.has(model.id),
		);
		const currentModel = availableById.get(this.model);

		if (
			currentModel &&
			!recommendedModels.some((model) => model.id === currentModel.id)
		) {
			return [...recommendedModels, currentModel];
		}

		return recommendedModels;
	}

	private async listOllamaNativeModels(): Promise<ChatModel[]> {
		const response = await this.requestAbsolute(
			'GET',
			`${ollamaNativeApiBaseUrl(this.baseUrl)}/tags`,
		);
		this.ensureOk(response);

		const payload = parseJson(response.text);
		return parseOllamaNativeModelList(payload);
	}

	private async listRecentOllamaCloudModelsForLocalOllama(): Promise<
		ChatModel[]
	> {
		const response = await this.requestAbsolute(
			'GET',
			`${OLLAMA_CLOUD_API_BASE_URL}/tags`,
			undefined,
			{},
		);
		this.ensureOk(response);

		const payload = parseJson(response.text);
		return parseOllamaCloudCatalogModelList(payload, {
			forLocalOllama: true,
			cutoffDate: monthsAgo(RECENT_MODEL_MAX_AGE_MONTHS),
		});
	}

	private async listRecentOpenRouterModels(): Promise<ChatModel[]> {
		const response = await this.requestAbsolute(
			'GET',
			OPENROUTER_MODEL_CATALOG_URL,
			undefined,
			{},
		);
		this.ensureOk(response);

		const payload = parseJson(response.text);
		return parseOpenRouterModelList(payload, {
			cutoffDate: monthsAgo(RECENT_MODEL_MAX_AGE_MONTHS),
		});
	}

	private async requestAbsolute(
		method: 'GET' | 'POST',
		url: string,
		body?: unknown,
		headers = this.buildHeaders(),
	): Promise<RequestUrlResponse> {
		try {
			return await requestUrl({
				url,
				method,
				headers,
				contentType: body ? 'application/json' : undefined,
				body: body ? JSON.stringify(body) : undefined,
				throw: false,
			});
		} catch {
			throw new RephraseApiError('The API endpoint could not be reached.');
		}
	}

	private async request(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
	): Promise<RequestUrlResponse> {
		return this.requestAbsolute(method, `${this.baseUrl}/${path}`, body);
	}

	private buildHeaders(): Record<string, string> {
		return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
	}

	private ensureOk(response: RequestUrlResponse): void {
		if (response.status >= 200 && response.status < 300) {
			return;
		}

		const apiMessage = parseApiError(response.text);
		const unsupportedParameter = readUnsupportedRequestParameter(
			response.status,
			apiMessage,
		);
		if (
			unsupportedParameter === 'response_format' ||
			isUnsupportedResponseFormat(response.status, apiMessage)
		) {
			throw new UnsupportedResponseFormatError();
		}

		if (
			unsupportedParameter === 'max_tokens' ||
			unsupportedParameter === 'max_completion_tokens'
		) {
			throw new UnsupportedTokenLimitParameterError(unsupportedParameter);
		}

		if (
			unsupportedParameter === 'reasoning' ||
			unsupportedParameter === 'reasoning_effort'
		) {
			throw new UnsupportedReasoningSettingError();
		}

		if (unsupportedParameter === 'temperature') {
			throw new UnsupportedTemperatureError();
		}

		if (response.status === 401 || response.status === 403) {
			throw new RephraseApiError('API authentication failed. Check your API key.');
		}

		if (response.status === 404 || /model.+not found|not found/i.test(apiMessage)) {
			throw this.modelNotFoundError();
		}

		throw new RephraseApiError(
			apiMessage || `The API returned HTTP ${response.status}.`,
		);
	}

	private modelNotFoundError(): RephraseApiError {
		const hint = isOllamaBaseUrl(this.baseUrl)
			? ` Run: ollama pull ${this.model}.`
			: '';

		return new RephraseApiError(`Model not found.${hint}`);
	}

	async testConnection(): Promise<ConnectionTestResult> {
		const models = await this.listModels();

		return {
			modelCount: models.length,
			configuredModelListed: models.some((model) => model.id === this.model),
		};
	}

	async rephrase(
		input: RephraseInput,
		options: RephraseOptions = {},
	): Promise<RephraseResult> {
		const request = normalizeRephraseOptions(options);
		const phase = request.avoidAlternatives.length > 0 ? 'background' : 'initial';
		let lastError: Error | null = null;

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const isRetry = attempt > 0;
			const contextIncluded = shouldIncludeContext(this.model) && !isRetry;
			try {
				return await this.rephraseOnce(input, request, isRetry);
			} catch (error) {
				if (error instanceof InvalidModelResponseError) {
					console.warn('[RephraseThis] Rejected invalid rephrase response', {
						phase,
						attempt: attempt + 1,
						reason: error.message,
						contextIncluded,
						requestedAlternatives: request.count,
						acceptedAlternatives: error.details?.acceptedAlternatives,
						rejectedAlternatives: error.details?.rejectedAlternatives,
					});
					lastError = error;
					continue;
				}

				throw error;
			}
		}

		throw lastError ?? new RephraseApiError('The API returned an invalid response.');
	}

	private async rephraseOnce(
		input: RephraseInput,
		request: Required<RephraseOptions>,
		isRetry: boolean,
	): Promise<RephraseResult> {
		let requestOptions: RephraseRequestOptions = {
			includeResponseFormat: true,
			includeReasoningDisabled: shouldDisableReasoning(
				this.baseUrl,
				this.model,
			),
			includeTemperature: true,
			tokenLimitParameter: preferredTokenLimitParameter(this.baseUrl),
		};
		const attemptedOptions = new Set<string>();

		for (let attempt = 0; attempt < 6; attempt += 1) {
			const optionKey = requestOptionsKey(requestOptions);
			if (attemptedOptions.has(optionKey)) {
				break;
			}

			attemptedOptions.add(optionKey);

			try {
				return await this.rephraseWithRequestOptions(
					input,
					request,
					requestOptions,
					isRetry,
				);
			} catch (error) {
				if (
					error instanceof UnsupportedResponseFormatError &&
					requestOptions.includeResponseFormat
				) {
					console.warn(
						'[RephraseThis] Provider rejected response_format; retrying without it',
						{ baseUrl: this.baseUrl, model: this.model },
					);
					requestOptions = {
						...requestOptions,
						includeResponseFormat: false,
					};
					continue;
				}

				if (error instanceof UnsupportedTokenLimitParameterError) {
					const fallbackParameter = fallbackTokenLimitParameter(error.parameter);
					if (fallbackParameter !== requestOptions.tokenLimitParameter) {
						console.warn(
							'[RephraseThis] Provider rejected token limit parameter; retrying with fallback',
							{
								baseUrl: this.baseUrl,
								model: this.model,
								rejectedParameter: error.parameter,
								fallbackParameter,
							},
						);
						requestOptions = {
							...requestOptions,
							tokenLimitParameter: fallbackParameter,
						};
						continue;
					}
				}

				if (
					error instanceof UnsupportedReasoningSettingError &&
					requestOptions.includeReasoningDisabled
				) {
					console.warn(
						'[RephraseThis] Provider rejected reasoning settings; retrying without them',
						{ baseUrl: this.baseUrl, model: this.model },
					);
					requestOptions = {
						...requestOptions,
						includeReasoningDisabled: false,
					};
					continue;
				}

				if (
					error instanceof UnsupportedTemperatureError &&
					requestOptions.includeTemperature
				) {
					console.warn(
						'[RephraseThis] Provider rejected temperature; retrying without it',
						{ baseUrl: this.baseUrl, model: this.model },
					);
					requestOptions = {
						...requestOptions,
						includeTemperature: false,
					};
					continue;
				}

				throw error;
			}
		}

		throw new RephraseApiError(
			'The API rejected every compatible request shape.',
		);
	}

	private async rephraseWithRequestOptions(
		input: RephraseInput,
		request: Required<RephraseOptions>,
		requestOptions: RephraseRequestOptions,
		isRetry: boolean,
	): Promise<RephraseResult> {
		const contextIncluded = shouldIncludeContext(this.model) && !isRetry;
		const body = {
			model: this.model,
			messages: [
				{
					role: 'system',
					content: buildSystemPrompt(this.rephrasePrompt, request.count, isRetry),
				},
				{
					role: 'user',
					content: buildUserPrompt(input, contextIncluded, request, isRetry),
				},
			],
			stream: false,
			...(requestOptions.includeTemperature
				? { temperature: isRetry ? 0.2 : 0.35 }
				: {}),
			[requestOptions.tokenLimitParameter]: REPHRASE_MAX_TOKENS,
			...(requestOptions.includeResponseFormat
				? { response_format: { type: 'json_object' } }
				: {}),
			...(requestOptions.includeReasoningDisabled
				? reasoningDisabledParameters(this.baseUrl, this.model)
				: {}),
		};
		const startedAt = performance.now();
		const response = await this.request('POST', 'chat/completions', body);
		const totalDuration = performance.now() - startedAt;

		this.ensureOk(response);

		return this.parseRephraseResponse(
			response,
			totalDuration,
			input,
			request,
		);
	}

	private parseRephraseResponse(
		response: RequestUrlResponse,
		totalDuration: number,
		input: RephraseInput,
		request: Required<RephraseOptions>,
	): RephraseResult {
		const payload = parseJson(response.text);
		if (!isRecord(payload) || !Array.isArray(payload.choices)) {
			throw new InvalidModelResponseError(
				'The API returned an unexpected chat response.',
				{ responseLength: response.text.length },
			);
		}

		const choices: unknown[] = payload.choices;
		const firstChoice = choices[0];
		if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
			throw new InvalidModelResponseError('The API returned no message choice.', {
				responseLength: response.text.length,
			});
		}

		if (readString(firstChoice.finish_reason) === 'length') {
			throw new InvalidModelResponseError(
				'The model response was cut off before it finished. Try again.',
			);
		}

		const content = readString(firstChoice.message.content);
		if (!content) {
			throw new InvalidModelResponseError('The model returned empty content.', {
				responseLength: response.text.length,
			});
		}

		const result = parseAlternativesWithExpectedCount(
			parseAlternativePayload(content),
			input.selectedText,
			request.count,
			request.avoidAlternatives,
		);
		if (result.rejected.length > 0) {
			console.warn('[RephraseThis] Rejected unusable alternatives', {
				phase: request.avoidAlternatives.length > 0 ? 'background' : 'initial',
				reasons: result.rejected,
				acceptedCount: result.alternatives.length,
				requestedAlternatives: request.count,
			});
		}
		if (result.alternatives.length === 0) {
			throw new InvalidModelResponseError('The model returned no usable alternatives.', {
				rejectedAlternatives: result.rejected.length,
				acceptedAlternatives: result.alternatives.length,
			});
		}

		const usage = isRecord(payload.usage) ? payload.usage : {};

		return {
			alternatives: result.alternatives,
			metrics: {
				totalDuration,
				promptTokens: readNumber(usage.prompt_tokens),
				completionTokens: readNumber(usage.completion_tokens),
				totalTokens: readNumber(usage.total_tokens),
			},
		};
	}

}

class InvalidModelResponseError extends RephraseApiError {
	constructor(
		reason = 'The API returned an invalid response.',
		readonly details?: Record<string, unknown>,
	) {
		super(reason);
		this.name = 'InvalidModelResponseError';
	}
}

class UnsupportedResponseFormatError extends RephraseApiError {
	constructor() {
		super('The API does not support response_format.');
		this.name = 'UnsupportedResponseFormatError';
	}
}

class UnsupportedTokenLimitParameterError extends RephraseApiError {
	constructor(readonly parameter: TokenLimitParameter) {
		super(`The API does not support ${parameter}.`);
		this.name = 'UnsupportedTokenLimitParameterError';
	}
}

class UnsupportedReasoningSettingError extends RephraseApiError {
	constructor() {
		super('The API does not support reasoning settings.');
		this.name = 'UnsupportedReasoningSettingError';
	}
}

class UnsupportedTemperatureError extends RephraseApiError {
	constructor() {
		super('The API does not support temperature.');
		this.name = 'UnsupportedTemperatureError';
	}
}

function normalizeRephraseOptions(
	options: RephraseOptions,
): Required<RephraseOptions> {
	return {
		count: clampInteger(
			options.count ?? DEFAULT_REPHRASE_COUNT,
			MIN_REPHRASE_COUNT,
			MAX_REPHRASE_COUNT,
		),
		avoidAlternatives:
			options.avoidAlternatives?.filter(
				(alternative) => alternative.trim().length > 0,
			) ?? [],
	};
}

function buildSystemPrompt(
	rephrasePrompt: string,
	count: number,
	isRetry: boolean,
): string {
	const retryInstruction = isRetry
		? `
The previous response could not be used. Be stricter this time:
- Return JSON only.
- Do not wrap the JSON in markdown.
- Use exactly the key "alternatives".
- Every alternative must be a string.`
		: '';

	return `${rephrasePrompt.trim()}

The requested number in the current user message overrides any earlier count.
${retryInstruction}

${buildResponseContractPrompt(count)}`;
}

function buildResponseContractPrompt(count: number): string {
	return `Return only valid JSON matching this schema:

{
  "alternatives": ${jsonArrayExample(count)}
}

	The alternatives array should contain ${count} string${count === 1 ? '' : 's'}.`;
}

function buildUserPrompt(
	input: RephraseInput,
	includeContext: boolean,
	request: Required<RephraseOptions>,
	isRetry: boolean,
): string {
	const avoidBlock = buildAvoidAlternativesBlock(request.avoidAlternatives);
	const countLabel = `${request.count} direct replacement${
		request.count === 1 ? '' : 's'
	}`;
	const retryLine = isRetry
		? 'Return the JSON object only. No prose, no markdown, no code fence.'
		: 'Return JSON only. No prose, no markdown, no code fence.';
	if (!includeContext) {
		return `Rewrite only this selected passage. Do not answer it, summarize it, or add advice.

<selected_text>
${input.selectedText}
</selected_text>
${avoidBlock}

${retryLine}
Return ${countLabel} for <selected_text> as JSON:
{ "alternatives": ${jsonArrayExample(request.count)} }`;
	}

	return `Rewrite only the text inside <selected_text>. The surrounding context is for voice and meaning only.

<selected_text>
${input.selectedText}
</selected_text>

<context_before>
${input.before}
</context_before>

<context_after>
${input.after}
</context_after>
${avoidBlock}

${retryLine}
Return ${countLabel} for <selected_text> as JSON:
{ "alternatives": ${jsonArrayExample(request.count)} }`;
}

function buildAvoidAlternativesBlock(avoidAlternatives: string[]): string {
	if (avoidAlternatives.length === 0) {
		return '';
	}

	return `
<avoid_alternatives>
${avoidAlternatives.join('\n')}
</avoid_alternatives>

Do not repeat or closely paraphrase anything inside <avoid_alternatives>.`;
}

function jsonArrayExample(count: number): string {
	return `[${Array.from({ length: count }, () => '"..."').join(', ')}]`;
}

function shouldIncludeContext(model: string): boolean {
	return !/\b0\.[0-9]+b\b/i.test(model);
}

function requestOptionsKey(options: RephraseRequestOptions): string {
	return [
		options.includeResponseFormat,
		options.includeReasoningDisabled,
		options.includeTemperature,
		options.tokenLimitParameter,
	].join(':');
}

function preferredTokenLimitParameter(baseUrl: string): TokenLimitParameter {
	return isOpenAiBaseUrl(baseUrl) ? 'max_completion_tokens' : 'max_tokens';
}

function fallbackTokenLimitParameter(
	parameter: TokenLimitParameter,
): TokenLimitParameter {
	return parameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
}

function shouldDisableReasoning(baseUrl: string, model: string): boolean {
	return isOllamaBaseUrl(baseUrl) || isOpenAiReasoningModel(baseUrl, model);
}

function reasoningDisabledParameters(
	baseUrl: string,
	model: string,
): Record<string, unknown> {
	if (isOllamaBaseUrl(baseUrl)) {
		return ollamaReasoningDisabled();
	}

	if (isOpenAiReasoningModel(baseUrl, model)) {
		return { reasoning_effort: 'none' };
	}

	return {};
}

function isOpenAiReasoningModel(baseUrl: string, model: string): boolean {
	if (!isOpenAiBaseUrl(baseUrl)) {
		return false;
	}

	return /^(gpt-5|o[0-9])/i.test(model.trim());
}

function normalizeApiBaseUrl(value: string): string {
	const trimmed = value.trim() || DEFAULT_API_BASE_URL;
	return trimmed.replace(/\/+$/, '');
}

function isOllamaBaseUrl(value: string): boolean {
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/v1$/i.test(value);
}

function isOllamaCloudOpenAiBaseUrl(value: string): boolean {
	return /^https:\/\/ollama\.com\/v1$/i.test(value);
}

function isOpenAiBaseUrl(value: string): boolean {
	return /^https:\/\/api\.openai\.com\/v1$/i.test(value);
}

function isOpenRouterBaseUrl(value: string): boolean {
	return /^https:\/\/openrouter\.ai\/api\/v1$/i.test(value);
}

function ollamaNativeApiBaseUrl(openAiBaseUrl: string): string {
	return openAiBaseUrl.replace(/\/v1$/i, '/api');
}

function monthsAgo(months: number): Date {
	const date = new Date();
	date.setMonth(date.getMonth() - months);
	return date;
}

function filterRecentModels(models: ChatModel[]): ChatModel[] {
	const cutoffTime = monthsAgo(RECENT_MODEL_MAX_AGE_MONTHS).getTime();
	return models.filter((model) => {
		if (typeof model.created !== 'number') {
			return false;
		}

		return model.created * 1000 >= cutoffTime;
	});
}

function ollamaReasoningDisabled(): Record<string, unknown> {
	// Ollama enables thinking by default for supported models. Rephrase needs a
	// short JSON answer, so disable reasoning to keep the token budget for content.
	return {
		reasoning_effort: 'none',
		reasoning: { effort: 'none' },
	};
}

function isUnsupportedResponseFormat(status: number, message: string): boolean {
	return (
		(status === 400 || status === 422) &&
		/response_format|json_object|unsupported.*format/i.test(message)
	);
}

function readUnsupportedRequestParameter(
	status: number,
	message: string,
): string | null {
	if (status !== 400 && status !== 422) {
		return null;
	}

	const unsupportedParameterMatch = message.match(
		/(?:unsupported|unrecognized|unknown|invalid)\s+parameter:?\s*['"]?([a-z_]+)['"]?/i,
	);
	if (unsupportedParameterMatch) {
		return unsupportedParameterMatch[1]?.toLowerCase() ?? null;
	}

	const notSupportedMatch = message.match(
		/['"]?([a-z_]+)['"]?\s+(?:is\s+)?not supported/i,
	);
	if (notSupportedMatch) {
		return notSupportedMatch[1]?.toLowerCase() ?? null;
	}

	return null;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new InvalidModelResponseError('The API returned malformed JSON.', {
			responseLength: value.length,
		});
	}
}

function parseApiError(value: string): string {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (isRecord(parsed)) {
			return (
				readNestedError(parsed.error) ??
				readString(parsed.message) ??
				readString(parsed.detail) ??
				value
			);
		}
	} catch {
		return value;
	}

	return value;
}

function readNestedError(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}

	if (isRecord(value)) {
		return readString(value.message) ?? readString(value.type);
	}

	return undefined;
}

function parseAlternativePayload(content: string): unknown {
	const parsedContent = parseModelJson(content);
	return isRecord(parsedContent) ? parsedContent.alternatives : parsedContent;
}

function parseModelJson(content: string): unknown {
	const candidates = [
		content,
		stripMarkdownFence(content),
		extractFirstJsonValue(content),
	].filter(isPresent);

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// Try the next bounded recovery candidate.
		}
	}

	throw new InvalidModelResponseError('The model returned malformed JSON.', {
		contentLength: content.length,
	});
}

function stripMarkdownFence(content: string): string | null {
	const match = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return match?.[1]?.trim() ?? null;
}

function extractFirstJsonValue(content: string): string | null {
	for (let index = 0; index < content.length; index += 1) {
		const opening = content[index];
		if (opening !== '{' && opening !== '[') {
			continue;
		}

		const extracted = extractBalancedJson(content, index, opening);
		if (extracted) {
			return extracted;
		}
	}

	return null;
}

function extractBalancedJson(
	content: string,
	startIndex: number,
	opening: string,
): string | null {
	const closing = opening === '{' ? '}' : ']';
	let depth = 0;
	let inString = false;
	let isEscaped = false;

	for (let index = startIndex; index < content.length; index += 1) {
		const char = content[index];

		if (inString) {
			if (isEscaped) {
				isEscaped = false;
				continue;
			}

			if (char === '\\') {
				isEscaped = true;
				continue;
			}

			if (char === '"') {
				inString = false;
			}

			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === opening) {
			depth += 1;
		}

		if (char === closing) {
			depth -= 1;
			if (depth === 0) {
				return content.slice(startIndex, index + 1);
			}
		}
	}

	return null;
}

function parseOpenAiModelList(payload: unknown): ChatModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new RephraseApiError('The API returned an unexpected model list.');
	}

	return uniqueModels(payload.data.map(parseOpenAiModel).filter(isPresent));
}

function parseOllamaNativeModelList(payload: unknown): ChatModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new RephraseApiError('The API returned an unexpected model list.');
	}

	return uniqueModels(payload.models.map(parseOllamaNativeModel).filter(isPresent));
}

function parseOllamaCloudCatalogModelList(
	payload: unknown,
	options: { forLocalOllama: boolean; cutoffDate: Date },
): ChatModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new RephraseApiError('The API returned an unexpected model list.');
	}

	const cutoffTime = options.cutoffDate.getTime();
	const models = payload.models
		.map((model) => parseOllamaCloudCatalogModel(model, options.forLocalOllama))
		.filter(isPresent)
		.filter((model) => {
			if (typeof model.created !== 'number') {
				return false;
			}

			return model.created * 1000 >= cutoffTime;
		});

	return uniqueModels(models);
}

function parseOpenRouterModelList(
	payload: unknown,
	options: { cutoffDate: Date },
): ChatModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new RephraseApiError('The API returned an unexpected model list.');
	}

	const cutoffTime = options.cutoffDate.getTime();
	const models = payload.data
		.map((model) => parseOpenRouterModel(model, cutoffTime))
		.filter(isPresent);

	return uniqueModels(models);
}

function parseOpenAiModel(value: unknown): ChatModel | null {
	if (!isRecord(value)) {
		return null;
	}

	const id = readString(value.id);
	if (!id) {
		return null;
	}

	return {
		id,
		name: id,
		created: readNumber(value.created),
		ownedBy: readString(value.owned_by),
	};
}

function parseOpenRouterModel(
	value: unknown,
	cutoffTime: number,
): ChatModel | null {
	if (!isRecord(value)) {
		return null;
	}

	const id = readString(value.id);
	const created = readNumber(value.created);
	if (!id || typeof created !== 'number' || created * 1000 < cutoffTime) {
		return null;
	}

	if (isExpiredOpenRouterModel(value) || !isTextChatOpenRouterModel(value)) {
		return null;
	}

	return {
		id,
		name: readString(value.name) ?? id,
		created,
		ownedBy: id.split('/')[0],
	};
}

function parseOllamaNativeModel(value: unknown): ChatModel | null {
	if (!isRecord(value)) {
		return null;
	}

	const id = readString(value.model) ?? readString(value.name);
	if (!id) {
		return null;
	}

	return {
		id,
		name: id,
	};
}

function parseOllamaCloudCatalogModel(
	value: unknown,
	forLocalOllama: boolean,
): ChatModel | null {
	if (!isRecord(value)) {
		return null;
	}

	const remoteName = readString(value.model) ?? readString(value.name);
	if (!remoteName) {
		return null;
	}

	const modifiedAt = readString(value.modified_at);
	const modifiedAtSeconds = modifiedAt
		? Math.floor(Date.parse(modifiedAt) / 1000)
		: undefined;

	if (modifiedAt && !Number.isFinite(modifiedAtSeconds)) {
		return null;
	}

	const id = forLocalOllama
		? toLocalOllamaCloudModelName(remoteName)
		: remoteName;

	return {
		id,
		name: id,
		created: modifiedAtSeconds,
		ownedBy: 'ollama-cloud',
	};
}

function isExpiredOpenRouterModel(value: Record<string, unknown>): boolean {
	const expirationDate = readString(value.expiration_date);
	if (!expirationDate) {
		return false;
	}

	const expirationTime = Date.parse(expirationDate);
	return Number.isFinite(expirationTime) && expirationTime <= Date.now();
}

function isTextChatOpenRouterModel(value: Record<string, unknown>): boolean {
	const id = readString(value.id)?.toLowerCase() ?? '';
	const name = readString(value.name)?.toLowerCase() ?? '';
	if (isObviouslyNonChatOpenRouterModel(`${id} ${name}`)) {
		return false;
	}

	const architecture = isRecord(value.architecture) ? value.architecture : {};
	const inputModalities = readStringArray(architecture.input_modalities);
	const outputModalities = readStringArray(architecture.output_modalities);

	if (inputModalities.length > 0 || outputModalities.length > 0) {
		return (
			inputModalities.includes('text') &&
			outputModalities.length === 1 &&
			outputModalities[0] === 'text'
		);
	}

	const modality = readString(architecture.modality)?.toLowerCase();
	if (!modality) {
		return false;
	}

	const [inputModality, outputModality] = modality
		.split('->')
		.map((part) => part.trim());
	const inputParts = inputModality?.split('+').map((part) => part.trim()) ?? [];
	const outputParts =
		outputModality?.split('+').map((part) => part.trim()) ?? [];

	return (
		inputParts.includes('text') &&
		outputParts.length === 1 &&
		outputParts[0] === 'text'
	);
}

function isObviouslyNonChatOpenRouterModel(value: string): boolean {
	const excludedFragments = [
		'audio',
		'embedding',
		'image',
		'moderation',
		'tts',
		'whisper',
	];

	return excludedFragments.some((fragment) => value.includes(fragment));
}

function toLocalOllamaCloudModelName(remoteName: string): string {
	if (remoteName.endsWith(':cloud') || remoteName.endsWith('-cloud')) {
		return remoteName;
	}

	return remoteName.includes(':') ? `${remoteName}-cloud` : `${remoteName}:cloud`;
}

function uniqueModels(models: ChatModel[]): ChatModel[] {
	const seen = new Set<string>();
	const unique: ChatModel[] = [];

	for (const model of models) {
		if (seen.has(model.id)) {
			continue;
		}

		seen.add(model.id);
		unique.push(model);
	}

	return unique;
}

function parseAlternativesWithExpectedCount(
	value: unknown,
	selectedText: string,
	expectedCount: number,
	avoidAlternatives: string[],
): { alternatives: string[]; rejected: string[] } {
	if (!Array.isArray(value)) {
		return {
			alternatives: [],
			rejected: ['Model JSON did not contain an alternatives array.'],
		};
	}

	const alternatives: string[] = [];
	const rejected: string[] = [];
	const seenAlternatives = new Set<string>();
	const normalizedAvoidAlternatives = new Set(avoidAlternatives.map(normalizeText));

	for (const item of value) {
		if (alternatives.length >= expectedCount) {
			break;
		}

		const alternative = readAlternativeText(item);
		if (!alternative) {
			rejected.push('Alternative was empty or not a string.');
			continue;
		}

		const normalizedAlternative = normalizeText(alternative);
		if (seenAlternatives.has(normalizedAlternative)) {
			rejected.push('Alternative repeats another suggestion.');
			continue;
		}

		if (normalizedAvoidAlternatives.has(normalizedAlternative)) {
			rejected.push('Alternative repeats an earlier suggestion.');
			continue;
		}

		const invalidReason = validateAlternative(alternative, selectedText);
		if (invalidReason) {
			rejected.push(invalidReason);
			continue;
		}

		seenAlternatives.add(normalizedAlternative);
		alternatives.push(alternative);
	}

	if (alternatives.length < expectedCount) {
		rejected.push(
			`Model returned ${alternatives.length} usable alternative${
				alternatives.length === 1 ? '' : 's'
			}; requested ${expectedCount}.`,
		);
	}

	return { alternatives, rejected };
}

function readAlternativeText(value: unknown): string | null {
	if (typeof value === 'string') {
		return value.trim() || null;
	}

	if (isRecord(value)) {
		return readString(value.text)?.trim() || null;
	}

	return null;
}

function validateAlternative(
	alternative: string,
	selectedText: string,
): string | null {
	const selectedLength = selectedText.trim().length;
	const alternativeLength = alternative.trim().length;
	const normalizedAlternative = normalizeText(alternative);
	const normalizedSelected = normalizeText(selectedText);

	if (normalizedAlternative === normalizedSelected) {
		return 'Alternative repeats the original text.';
	}

	if (selectedLength >= 80 && alternativeLength < selectedLength * 0.45) {
		return 'Alternative too short.';
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(alternative.trim())) {
		return 'Alternative looks like a date.';
	}

	const selectedLower = selectedText.toLowerCase();
	const alternativeLower = alternative.toLowerCase();
	const contextLeakPhrases = [
		'surrounding context',
		'selected passage',
		'selected text',
		'obsidian plugin',
		'build this plugin',
		'best way to build',
		'feel free to ask',
		'i would recommend',
		'it is important to consider',
	];
	const leakedPhrase = contextLeakPhrases.find(
		(phrase) =>
			alternativeLower.includes(phrase) && !selectedLower.includes(phrase),
	);

	if (leakedPhrase) {
		return 'Alternative appears to use prompt or context language.';
	}

	return null;
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}

	return Math.min(Math.max(Math.round(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((item) => readString(item)?.trim().toLowerCase())
		.filter(isPresent);
}

function isPresent<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}
