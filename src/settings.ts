import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { REPHRASE_COMMAND_NAME } from './commands';
import type RephraseThisPlugin from './main';
import {
	ChatCompletionsClient,
	type ChatCompletionsSettings,
	DEFAULT_API_BASE_URL,
	DEFAULT_API_KEY,
	DEFAULT_MODEL,
	DEFAULT_OPENAI_MODEL,
	DEFAULT_REPHRASE_PROMPT,
	OPENAI_RECOMMENDED_MODELS,
	getRephraseApiErrorMessage,
	type ChatModel,
} from './chat-completions';

export type ProviderPreset = 'ollama' | 'openai' | 'openrouter' | 'custom';
type ModelEntryMode = 'recommended' | 'custom';

export interface RephraseThisSettings {
	providerPreset: ProviderPreset;
	apiBaseUrl: string;
	apiKeySecretName: string;
	model: string;
	modelEntryMode: ModelEntryMode;
	rephrasePrompt: string;
	contextChars: number;
	showSelectionRephraseButton: boolean;
}

export interface RephraseConfigurationWarning {
	buttonText: string;
	noticeText: string;
	ariaLabel: string;
}

export const DEFAULT_CONTEXT_CHARS = 400;
export const MIN_CONTEXT_CHARS = 0;
export const MAX_CONTEXT_CHARS = 3000;
export const CONTEXT_CHARS_STEP = 100;

export const DEFAULT_SETTINGS: RephraseThisSettings = {
	providerPreset: 'ollama',
	apiBaseUrl: DEFAULT_API_BASE_URL,
	apiKeySecretName: '',
	model: DEFAULT_MODEL,
	modelEntryMode: 'recommended',
	rephrasePrompt: DEFAULT_REPHRASE_PROMPT,
	contextChars: DEFAULT_CONTEXT_CHARS,
	showSelectionRephraseButton: true,
};

const PRESET_OPTIONS: Record<ProviderPreset, string> = {
	ollama: 'Ollama',
	openai: 'OpenAI',
	openrouter: 'OpenRouter',
	custom: 'Custom',
};

const PRESET_BASE_URLS: Record<ProviderPreset, string> = {
	ollama: DEFAULT_API_BASE_URL,
	openai: 'https://api.openai.com/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	custom: '',
};
const LEGACY_API_KEY_FIELD = 'apiKey';
const HOTKEY_SETUP_NOTICE_DURATION_MS = 16000;
const HOTKEY_SETTINGS_TAB_ID = 'hotkeys';
const MODEL_LOADING_OPTION_VALUE = '__rephrasethis_loading_models__';

type ModelLoadState = 'idle' | 'loading' | 'loaded' | 'failed';

interface InternalSettingsController {
	open?: () => Promise<void> | void;
	openTabById?: (id: string) => void;
}

interface AppWithInternalSettings extends App {
	setting?: InternalSettingsController;
}

export function loadRephraseThisSettings(value: unknown): RephraseThisSettings {
	const saved = isRecord(value) ? value : {};
	const apiBaseUrl =
		readString(saved.apiBaseUrl) ??
		migrateLegacyOllamaUrl(readString(saved.ollamaUrl));
	const providerPreset = readProviderPreset(saved.providerPreset, apiBaseUrl);

	return {
		providerPreset,
		apiBaseUrl: apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl,
		apiKeySecretName:
			readString(saved.apiKeySecretName) ??
			readString(saved.apiKeySecretId) ??
			'',
		model: readString(saved.model) ?? DEFAULT_SETTINGS.model,
		modelEntryMode: readModelEntryMode(saved.modelEntryMode, providerPreset),
		rephrasePrompt:
			readString(saved.rephrasePrompt) ?? DEFAULT_SETTINGS.rephrasePrompt,
		contextChars: readContextChars(saved.contextChars),
		showSelectionRephraseButton:
			readBoolean(saved.showSelectionRephraseButton) ??
			DEFAULT_SETTINGS.showSelectionRephraseButton,
	};
}

export function readLegacyApiKey(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return readString(value[LEGACY_API_KEY_FIELD]);
}

export function shouldSaveSettingsAfterSecretMigration(
	value: unknown,
	settings: RephraseThisSettings,
): boolean {
	if (!isRecord(value) || !(LEGACY_API_KEY_FIELD in value)) {
		return false;
	}

	const legacyApiKey = readLegacyApiKey(value);
	if (isPersistableApiKey(legacyApiKey, settings.providerPreset)) {
		return false;
	}

	return true;
}

export function migrateLegacyApiKeyToSecretStorage(
	app: App,
	value: unknown,
	settings: RephraseThisSettings,
): boolean {
	const legacyApiKey = readLegacyApiKey(value);
	if (!isPersistableApiKey(legacyApiKey, settings.providerPreset)) {
		return false;
	}

	const secretName = defaultApiKeySecretName(settings.providerPreset);
	app.secretStorage.setSecret(secretName, legacyApiKey);
	settings.apiKeySecretName = secretName;
	return true;
}

export function resolveChatCompletionsSettings(
	app: App,
	settings: RephraseThisSettings,
): ChatCompletionsSettings {
	return {
		apiBaseUrl: settings.apiBaseUrl,
		apiKey: resolveApiKey(app, settings),
		model: settings.model,
		rephrasePrompt: settings.rephrasePrompt,
	};
}

export function getRephraseConfigurationWarning(
	app: App,
	settings: RephraseThisSettings,
): RephraseConfigurationWarning | null {
	if (settings.apiBaseUrl.trim().length === 0) {
		return {
			buttonText: 'Set API URL',
			noticeText: 'Set an API base URL in Settings > RephraseThis.',
			ariaLabel: 'Set an API base URL before rephrasing',
		};
	}

	if (settings.model.trim().length === 0) {
		return {
			buttonText: 'Set model',
			noticeText: 'Choose an AI model in Settings > RephraseThis.',
			ariaLabel: 'Choose an AI model before rephrasing',
		};
	}

	if (requiresConfiguredApiKey(settings) && resolveApiKey(app, settings).trim().length === 0) {
		return {
			buttonText: 'Set up API key',
			noticeText: 'Set up your API key in Settings > RephraseThis.',
			ariaLabel: 'Set up an API key before rephrasing',
		};
	}

	return null;
}

export class RephraseThisSettingTab extends PluginSettingTab {
	plugin: RephraseThisPlugin;
	private modelOptions: ChatModel[] = [];
	private modelLoadKey = '';
	private modelLoadState: ModelLoadState = 'idle';
	private modelLoadError: string | null = null;
	private apiKeyModelRefreshTimeout: number | null = null;

	constructor(app: App, plugin: RephraseThisPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.classList.add('rephrasethis-settings');

		this.displayRephraseBehaviorSection(containerEl);
		this.displayAiModelSection(containerEl);
		this.displayPromptSetting(containerEl);
		this.displayAdvancedRephrasingSettings(containerEl);
	}

	private displayProviderSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Choose where suggestions come from.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(PRESET_OPTIONS)
					.setValue(this.plugin.settings.providerPreset)
					.onChange(async (value) => {
						const preset = readProviderPreset(value, undefined);
						const previousPreset = this.plugin.settings.providerPreset;
						this.plugin.settings.providerPreset = preset;

						if (preset !== 'custom') {
							this.plugin.settings.apiBaseUrl = PRESET_BASE_URLS[preset];
						}

						if (preset !== previousPreset) {
							this.plugin.settings.apiKeySecretName =
								getStoredApiKeySecretName(this.app, preset) ?? '';
							this.plugin.settings.modelEntryMode =
								preset === 'custom' ? 'custom' : 'recommended';
						}

						if (
							preset === 'openai' &&
							shouldUseOpenAiDefaultModel(this.plugin.settings.model)
						) {
							this.plugin.settings.model = DEFAULT_OPENAI_MODEL;
						}

						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}

	private displayApiBaseUrlSetting(
		containerEl: HTMLElement,
		desc = 'Base /v1 endpoint for your provider.',
	): void {
		new Setting(containerEl)
			.setName('API base URL')
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.classList.add('rephrasethis-api-base-url-input');
				text
					.setPlaceholder(DEFAULT_API_BASE_URL)
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiBaseUrl =
							value.trim() || DEFAULT_API_BASE_URL;
						this.plugin.settings.providerPreset = inferProviderPreset(
							this.plugin.settings.apiBaseUrl,
						);
						await this.plugin.saveSettings();
					});
			});
	}

	private displayApiKeySetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName('API key')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.inputEl.classList.add('rephrasethis-api-key-input');
				text
					.setPlaceholder('API key')
					.setValue(readConfiguredApiKey(this.app, this.plugin.settings))
					.onChange(async (value) => {
						this.saveApiKeySecret(value);
						await this.plugin.saveSettings();
						this.scheduleModelRefreshAfterApiKeyChange();
					});
			});
		setting.settingEl.classList.add('rephrasethis-api-key-setting');

		let secretVisible = false;
		setting.addExtraButton((button) => {
			button
				.setIcon('eye')
				.setTooltip('Show API key')
				.onClick(() => {
					secretVisible = !secretVisible;
					setSecretInputVisible(setting, secretVisible);
					button
						.setIcon(secretVisible ? 'eye-off' : 'eye')
						.setTooltip(secretVisible ? 'Hide API key' : 'Show API key');
				});
		});
	}

	private displayModelSetting(containerEl: HTMLElement): void {
		this.syncModelDiscoveryState();
		this.requestInitialModelDiscovery();

		const modelOptions = this.getVisibleModelOptions();
		const shouldUseCustomInput = this.shouldShowCustomModelInput(modelOptions);
		if (shouldUseCustomInput) {
			this.displayCustomModelInput(containerEl, modelOptions);
			return;
		}

		this.displayModelDropdown(containerEl, modelOptions);
	}

	private displayModelDropdown(
		containerEl: HTMLElement,
		modelOptions: ChatModel[],
	): void {
		const setting = new Setting(containerEl)
			.setName('Model')
			.setDesc(this.getModelDropdownDescription())
			.addDropdown((dropdown) => {
				dropdown.selectEl.classList.add('rephrasethis-model-select');
				const options =
					modelOptions.length > 0
						? buildModelOptions(modelOptions)
						: { [MODEL_LOADING_OPTION_VALUE]: 'Loading models...' };

				dropdown
					.addOptions(options)
					.setValue(
						modelOptions.length > 0
							? this.plugin.settings.model
							: MODEL_LOADING_OPTION_VALUE,
					)
					.onChange(async (value) => {
						if (value === MODEL_LOADING_OPTION_VALUE) {
							return;
						}

						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
						this.display();
					});
				dropdown.selectEl.disabled = modelOptions.length === 0;
			});
		setting.settingEl.classList.add('rephrasethis-model-setting');

		setting.addButton((button) => {
			button
				.setButtonText('Use custom model')
				.setTooltip('Enter a model ID or alias')
				.onClick(async () => {
					this.plugin.settings.modelEntryMode = 'custom';
					await this.plugin.saveSettings();
					this.display();
				});
			button.buttonEl.addClass('rephrasethis-link-button');
		});
	}

	private displayCustomModelInput(
		containerEl: HTMLElement,
		modelOptions: ChatModel[],
	): void {
		const setting = new Setting(containerEl)
			.setName('Model')
			.setDesc(this.getModelInputDescription())
			.addText((text) => {
				text.inputEl.classList.add('rephrasethis-model-input');
				text
					.setPlaceholder(DEFAULT_MODEL)
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || DEFAULT_MODEL;
						await this.plugin.saveSettings();
					});
			});
		setting.settingEl.classList.add('rephrasethis-model-setting');

		if (modelOptions.length > 0) {
			setting.addButton((button) => {
				button
					.setButtonText(this.getChooseRecommendedButtonText())
					.setTooltip('Choose from available models')
					.onClick(async () => {
						this.plugin.settings.modelEntryMode = 'recommended';
						if (
							!modelOptions.some(
								(model) => model.id === this.plugin.settings.model,
							)
						) {
							this.plugin.settings.model = modelOptions[0]?.id ?? DEFAULT_MODEL;
						}
						await this.plugin.saveSettings();
						this.display();
					});
				button.buttonEl.addClass('rephrasethis-link-button');
			});
		}
	}

	private getModelInputDescription(): string {
		if (this.modelLoadState === 'loading') {
			return 'Loading models. Manual entry still works.';
		}

		if (this.modelLoadState === 'failed') {
			return `Manual entry still works. Could not load models: ${
				this.modelLoadError ?? 'unknown error'
			}`;
		}

		if (this.modelLoadState === 'loaded') {
			return 'Enter a model ID or alias.';
		}

		if (
			this.plugin.settings.providerPreset === 'openai' &&
			!this.hasConfiguredApiKey()
		) {
			return 'Choose an OpenAI API key secret to verify available models. Manual entry still works.';
		}

		return 'Enter a model ID or alias.';
	}

	private getModelDropdownDescription(): string {
		if (this.plugin.settings.providerPreset === 'openai') {
			if (this.modelLoadState === 'loading') {
				return 'Checking which recommended OpenAI models your key can access. Manual entry still works.';
			}

			if (this.modelLoadState === 'failed') {
				return `Recommended OpenAI models are shown. Could not verify access: ${
					this.modelLoadError ?? 'unknown error'
				}`;
			}

			if (this.modelLoadState === 'loaded' && this.modelOptions.length === 0) {
				return 'Recommended OpenAI models are shown, but none were confirmed for this key.';
			}

			if (this.modelLoadState === 'loaded') {
				return 'Choose a recommended OpenAI model available to your account.';
			}

			if (!this.hasConfiguredApiKey()) {
				return 'Choose a recommended OpenAI model. Select an API key secret to verify access.';
			}

			return 'Choose a recommended OpenAI model.';
		}

		return 'Choose a discovered recent model.';
	}

	private syncModelDiscoveryState(): void {
		const key = this.getModelDiscoveryKey();
		if (this.modelLoadKey === key) {
			return;
		}

		this.modelLoadKey = key;
		this.modelOptions = [];
		this.modelLoadState = 'idle';
		this.modelLoadError = null;
	}

	private requestInitialModelDiscovery(): void {
		if (
			!this.shouldAutoDiscoverModels() ||
			this.modelLoadState !== 'idle'
		) {
			return;
		}

		this.startModelRefresh({ silent: true });
	}

	private startModelRefresh(options: { silent: boolean }): void {
		const key = this.getModelDiscoveryKey();
		this.modelLoadKey = key;
		this.modelLoadState = 'loading';
		this.modelLoadError = null;

		if (!options.silent) {
			this.display();
		}

		void this.loadModels(key, options.silent);
	}

	private async loadModels(key: string, silent: boolean): Promise<void> {
		try {
			const models = await this.createClient().listModels();

			if (this.modelLoadKey !== key) {
				return;
			}

			this.modelOptions = normalizeModels(models);
			this.modelLoadState = 'loaded';
			await this.selectFirstDiscoveredModelIfNeeded();

			if (!silent) {
				new Notice(
					`Found ${this.modelOptions.length} ${this.getModelListLabel()}.`,
				);
			}
		} catch (error) {
			if (this.modelLoadKey !== key) {
				return;
			}

			this.modelOptions = [];
			this.modelLoadState = 'failed';
			this.modelLoadError = getRephraseApiErrorMessage(error);

			if (!silent) {
				new Notice(this.modelLoadError);
			}
		}

		if (this.modelLoadKey === key) {
			this.display();
		}
	}

	private getModelDiscoveryKey(): string {
		return [
			this.plugin.settings.providerPreset,
			this.plugin.settings.apiBaseUrl,
			this.plugin.settings.apiKeySecretName,
		].join('\n');
	}

	private getVisibleModelOptions(): ChatModel[] {
		if (this.modelOptions.length > 0) {
			return this.modelOptions;
		}

		if (this.plugin.settings.providerPreset === 'openai') {
			return OPENAI_RECOMMENDED_MODELS;
		}

		return [];
	}

	private shouldShowCustomModelInput(modelOptions: ChatModel[]): boolean {
		if (this.plugin.settings.providerPreset === 'custom') {
			return true;
		}

		if (this.plugin.settings.modelEntryMode === 'custom') {
			return true;
		}

		if (
			this.shouldAutoDiscoverModels() &&
			this.modelLoadState === 'loading' &&
			modelOptions.length === 0
		) {
			return false;
		}

		if (modelOptions.length === 0) {
			return true;
		}

		return !modelOptions.some(
			(model) => model.id === this.plugin.settings.model,
		);
	}

	private async selectFirstDiscoveredModelIfNeeded(): Promise<void> {
		if (
			this.plugin.settings.providerPreset === 'custom' ||
			this.plugin.settings.modelEntryMode === 'custom' ||
			this.modelOptions.length === 0 ||
			this.modelOptions.some((model) => model.id === this.plugin.settings.model)
		) {
			return;
		}

		const firstModel = this.modelOptions[0];
		if (!firstModel) {
			return;
		}

		this.plugin.settings.model = firstModel.id;
		await this.plugin.saveSettings();
	}

	private getChooseRecommendedButtonText(): string {
		if (this.plugin.settings.providerPreset === 'openai') {
			return 'Choose recommended model';
		}

		return 'Choose discovered model';
	}

	private getModelListLabel(): string {
		if (this.plugin.settings.providerPreset === 'openai') {
			return 'recommended models';
		}

		return 'recent models';
	}

	private scheduleModelRefreshAfterApiKeyChange(): void {
		if (this.plugin.settings.providerPreset !== 'openai') {
			return;
		}

		if (this.apiKeyModelRefreshTimeout !== null) {
			window.clearTimeout(this.apiKeyModelRefreshTimeout);
			this.apiKeyModelRefreshTimeout = null;
		}

		this.modelLoadKey = '';
		this.modelOptions = [];
		this.modelLoadState = 'idle';
		this.modelLoadError = null;

		if (!this.hasConfiguredApiKey()) {
			this.display();
			return;
		}

		this.apiKeyModelRefreshTimeout = window.setTimeout(() => {
			this.apiKeyModelRefreshTimeout = null;
			if (
				this.plugin.settings.providerPreset === 'openai' &&
				this.hasConfiguredApiKey()
			) {
				this.startModelRefresh({ silent: false });
			}
		}, 700);
	}

	private createClient(): ChatCompletionsClient {
		return new ChatCompletionsClient(
			resolveChatCompletionsSettings(this.app, this.plugin.settings),
		);
	}

	private hasConfiguredApiKey(): boolean {
		return resolveApiKey(this.app, this.plugin.settings).trim().length > 0;
	}

	private saveApiKeySecret(value: string): void {
		const apiKey = value.trim();
		const secretName = defaultApiKeySecretName(
			this.plugin.settings.providerPreset,
		);

		if (apiKey.length === 0) {
			this.app.secretStorage.setSecret(secretName, '');
			this.plugin.settings.apiKeySecretName = '';
			return;
		}

		this.app.secretStorage.setSecret(secretName, apiKey);
		this.plugin.settings.apiKeySecretName = secretName;
	}

	private shouldAutoDiscoverModels(): boolean {
		if (
			this.plugin.settings.providerPreset === 'ollama' ||
			this.plugin.settings.providerPreset === 'openrouter'
		) {
			return true;
		}

		return (
			this.plugin.settings.providerPreset === 'openai' &&
			this.hasConfiguredApiKey()
		);
	}

	private displayPromptSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Rephrasing instructions')
			.setDesc('Controls how suggestions are written.')
			.setHeading();

		const setting = new Setting(containerEl)
			.setName('Instructions')
			.setDesc('The next rephrase request uses the saved instructions.');
		setting.settingEl.classList.add('rephrasethis-prompt-setting');

		setting.addTextArea((text) => {
			text.inputEl.rows = 18;
			text.inputEl.classList.add('rephrasethis-prompt-textarea');

			text
				.setPlaceholder(DEFAULT_REPHRASE_PROMPT)
				.setValue(this.plugin.settings.rephrasePrompt)
				.onChange(async (value) => {
					this.plugin.settings.rephrasePrompt =
						value.trim().length > 0 ? value : DEFAULT_REPHRASE_PROMPT;
					await this.plugin.saveSettings();
				});
		});

		setting.addButton((button) => {
			button
				.setButtonText('Restore default')
				.onClick(async () => {
					this.plugin.settings.rephrasePrompt = DEFAULT_REPHRASE_PROMPT;
					await this.plugin.saveSettings();
					this.display();
				});
			button.buttonEl.addClass('rephrasethis-restore-prompt-button');
		});
	}

	private displayAdvancedRephrasingSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Advanced rephrasing')
			.setDesc('Tune how much nearby writing this plugin reads.')
			.setHeading();

		const setting = new Setting(containerEl)
			.setName('Writing context')
			.setDesc(
				'This plugin can read nearby text to better match your voice. More context may improve suggestions, but can be slower.',
			);
		setting.settingEl.classList.add('rephrasethis-context-setting');

		const valueEl = activeDocument.createElement('span');
		valueEl.className = 'rephrasethis-context-value';
		valueEl.textContent = formatContextChars(this.plugin.settings.contextChars);

		const saveContextChars = async (value: number): Promise<void> => {
			const contextChars = normalizeContextChars(value);
			this.plugin.settings.contextChars = contextChars;
			valueEl.textContent = formatContextChars(contextChars);
			await this.plugin.saveSettings();
		};

		setting.addSlider((slider) => {
			slider
				.setLimits(
					MIN_CONTEXT_CHARS,
					MAX_CONTEXT_CHARS,
					CONTEXT_CHARS_STEP,
				)
				.setInstant(true)
				.setValue(this.plugin.settings.contextChars)
				.onChange(async (value) => {
					await saveContextChars(value);
				});
			slider.sliderEl.classList.add('rephrasethis-context-slider');
		});
		setting.controlEl.append(valueEl);
		setting.addExtraButton((button) => {
			button
				.setIcon('rotate-ccw')
				.setTooltip('Reset writing context')
				.onClick(() => {
					const sliderEl = setting.controlEl.querySelector<HTMLInputElement>(
						'.rephrasethis-context-slider',
					);
					if (sliderEl) {
						sliderEl.value = String(DEFAULT_CONTEXT_CHARS);
					}

					void saveContextChars(DEFAULT_CONTEXT_CHARS);
				});
			button.extraSettingsEl.addClass('rephrasethis-context-reset-button');
		});
	}

	private displayConnectionSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Connection')
			.setDesc('Check the current provider and refresh the model list.')
			.addButton((button) =>
				button.setButtonText('Test connection').onClick(async () => {
					try {
						const result = await this.createClient().testConnection();

						new Notice(
							result.configuredModelListed
								? `Connected. Found ${result.modelCount} models.`
								: `Connected. Found ${result.modelCount} models, but the configured model was not listed.`,
						);
					} catch (error) {
						new Notice(getRephraseApiErrorMessage(error));
					}
				}),
			)
			.addButton((button) => {
				button
					.setButtonText(
						this.modelLoadState === 'loading'
							? 'Refreshing models'
							: 'Refresh models',
					)
					.onClick(() => {
						if (this.modelLoadState === 'loading') {
							return;
						}

						this.startModelRefresh({ silent: false });
					});
				button.buttonEl.disabled = this.modelLoadState === 'loading';
			});
	}

	private displayRephraseBehaviorSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Rephrase behavior')
			.setDesc('Choose how this plugin appears while you write.')
			.setHeading();

		new Setting(containerEl)
			.setName('Show rephrase button when text is selected')
			.setDesc('Shows a small rephrase button after you select text.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSelectionRephraseButton)
					.onChange(async (value) => {
						this.plugin.settings.showSelectionRephraseButton = value;
						await this.plugin.saveSettings();
					}),
			);

		this.displayKeyboardShortcutSetting(containerEl);
	}

	private displayKeyboardShortcutSetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName('Keyboard shortcut');

		setting
			.addButton((button) =>
				button
					.setButtonText('Open hotkeys')
					.onClick(async () => {
						const commandCopied = await copyRephraseCommandName();
						const hotkeysOpened = await openHotkeysSettings(this.app);
						const searchFilled =
							hotkeysOpened &&
							(await fillHotkeySearchInput(REPHRASE_COMMAND_NAME));

						showHotkeySetupNotice(
							commandCopied,
							hotkeysOpened,
							searchFilled,
						);
					}),
			);
	}

	private displayAiModelSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('AI model')
			.setDesc('Choose the model used for suggestions.')
			.setHeading();

		this.displayProviderSetting(containerEl);

		if (this.plugin.settings.providerPreset === 'custom') {
			this.displayApiBaseUrlSetting(containerEl);
		}

		if (this.plugin.settings.providerPreset !== 'ollama') {
			this.displayApiKeySetting(containerEl);
		}

		this.displayModelSetting(containerEl);
		this.displayConnectionSetting(containerEl);

		if (this.plugin.settings.providerPreset !== 'custom') {
			this.displayAdvancedConnectionSettings(containerEl);
		}
	}

	private displayAdvancedConnectionSettings(containerEl: HTMLElement): void {
		const detailsEl = activeDocument.createElement('details');
		detailsEl.className = 'rephrasethis-advanced-settings';

		const summaryEl = activeDocument.createElement('summary');
		summaryEl.textContent = 'Advanced connection settings';
		detailsEl.append(summaryEl);

		const descEl = activeDocument.createElement('p');
		descEl.className =
			'setting-item-description rephrasethis-advanced-description';
		descEl.textContent =
			'Base URL overrides and provider-specific authentication. API keys are stored in Obsidian secret storage.';
		detailsEl.append(descEl);

		containerEl.append(detailsEl);

		this.displayApiBaseUrlSetting(
			detailsEl,
			'Override the preset /v1 endpoint.',
		);

		if (this.plugin.settings.providerPreset === 'ollama') {
			this.displayApiKeySetting(detailsEl);
		}
	}
}

function migrateLegacyOllamaUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const trimmed = value.trim().replace(/\/+$/, '');
	if (trimmed.endsWith('/v1')) {
		return trimmed;
	}

	if (trimmed.endsWith('/api')) {
		return `${trimmed.slice(0, -4)}/v1`;
	}

	return `${trimmed}/v1`;
}

function readProviderPreset(
	value: unknown,
	apiBaseUrl: string | undefined,
): ProviderPreset {
	if (typeof value === 'string' && isProviderPreset(value)) {
		return value;
	}

	return inferProviderPreset(apiBaseUrl);
}

function readModelEntryMode(
	value: unknown,
	providerPreset: ProviderPreset,
): ModelEntryMode {
	if (providerPreset === 'custom') {
		return 'custom';
	}

	return value === 'custom' || value === 'recommended' ? value : 'recommended';
}

function inferProviderPreset(apiBaseUrl: string | undefined): ProviderPreset {
	const normalized = apiBaseUrl?.trim().replace(/\/+$/, '').toLowerCase();

	if (!normalized) {
		return DEFAULT_SETTINGS.providerPreset;
	}

	if (normalized === DEFAULT_API_BASE_URL) {
		return 'ollama';
	}

	if (normalized === PRESET_BASE_URLS.openai) {
		return 'openai';
	}

	if (normalized === PRESET_BASE_URLS.openrouter) {
		return 'openrouter';
	}

	return 'custom';
}

function isProviderPreset(value: string): value is ProviderPreset {
	return value in PRESET_OPTIONS;
}

function requiresConfiguredApiKey(settings: RephraseThisSettings): boolean {
	return settings.providerPreset === 'openai' || settings.providerPreset === 'openrouter';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function setSecretInputVisible(setting: Setting, visible: boolean): void {
	const inputEl = setting.controlEl.querySelector('input');
	if (!inputEl) {
		return;
	}

	inputEl.type = visible ? 'text' : 'password';
}

function readConfiguredApiKey(app: App, settings: RephraseThisSettings): string {
	const secretName = getReadableApiKeySecretName(app, settings);
	if (!secretName) {
		return '';
	}

	return app.secretStorage.getSecret(secretName) ?? '';
}

function resolveApiKey(app: App, settings: RephraseThisSettings): string {
	const secretName = getReadableApiKeySecretName(app, settings);
	if (secretName) {
		return app.secretStorage.getSecret(secretName) ?? '';
	}

	if (settings.providerPreset === 'ollama') {
		return DEFAULT_API_KEY;
	}

	return '';
}

function getReadableApiKeySecretName(
	app: App,
	settings: RephraseThisSettings,
): string | null {
	const configuredName = settings.apiKeySecretName.trim();
	if (
		configuredName.length > 0 &&
		app.secretStorage.getSecret(configuredName) !== null
	) {
		return configuredName;
	}

	return getStoredApiKeySecretName(app, settings.providerPreset);
}

function getStoredApiKeySecretName(
	app: App,
	providerPreset: ProviderPreset,
): string | null {
	const secretName = defaultApiKeySecretName(providerPreset);
	return app.secretStorage.getSecret(secretName) !== null ? secretName : null;
}

function isPersistableApiKey(
	value: string | undefined,
	providerPreset: ProviderPreset,
): value is string {
	const trimmed = value?.trim();
	if (!trimmed) {
		return false;
	}

	return !(providerPreset === 'ollama' && trimmed === DEFAULT_API_KEY);
}

function defaultApiKeySecretName(providerPreset: ProviderPreset): string {
	return `rephrasethis-${providerPreset}-api-key`;
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function readContextChars(value: unknown): number {
	if (typeof value !== 'number') {
		return DEFAULT_CONTEXT_CHARS;
	}

	return normalizeContextChars(value);
}

function normalizeContextChars(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_CONTEXT_CHARS;
	}

	const steppedValue =
		Math.round(value / CONTEXT_CHARS_STEP) * CONTEXT_CHARS_STEP;
	return Math.min(
		MAX_CONTEXT_CHARS,
		Math.max(MIN_CONTEXT_CHARS, steppedValue),
	);
}

function formatContextChars(value: number): string {
	const normalizedValue = normalizeContextChars(value);
	if (normalizedValue === 0) {
		return 'Selection only';
	}

	return `${normalizedValue.toLocaleString()} characters before and after`;
}

function buildModelOptions(models: ChatModel[]): Record<string, string> {
	return models.reduce<Record<string, string>>((acc, model) => {
		acc[model.id] = model.name;
		return acc;
	}, {});
}

function normalizeModels(models: ChatModel[]): ChatModel[] {
	const seen = new Set<string>();
	const normalizedModels: ChatModel[] = [];

	for (const model of models) {
		const id = model.id.trim();
		const name = model.name.trim() || id;
		if (!id || seen.has(id)) {
			continue;
		}

		seen.add(id);
		normalizedModels.push({
			...model,
			id,
			name,
		});
	}

	return normalizedModels;
}

function shouldUseOpenAiDefaultModel(model: string): boolean {
	const trimmed = model.trim();
	if (!trimmed) {
		return true;
	}

	return !/^(gpt-|o[0-9])/i.test(trimmed);
}

async function copyRephraseCommandName(): Promise<boolean> {
	try {
		await activeWindow.navigator.clipboard.writeText(REPHRASE_COMMAND_NAME);
		return true;
	} catch {
		return false;
	}
}

async function openHotkeysSettings(app: App): Promise<boolean> {
	const settingsController = (app as AppWithInternalSettings).setting;
	if (!settingsController?.open || !settingsController.openTabById) {
		return false;
	}

	try {
		await settingsController.open();
		settingsController.openTabById(HOTKEY_SETTINGS_TAB_ID);
		return true;
	} catch {
		return false;
	}
}

async function fillHotkeySearchInput(value: string): Promise<boolean> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		await waitForNextFrame();

		const inputEl = findHotkeySearchInput();
		if (inputEl) {
			setTextInputValue(inputEl, value);
			return true;
		}
	}

	return false;
}

function findHotkeySearchInput(): HTMLInputElement | HTMLTextAreaElement | null {
	const focusedInput = asTextInput(activeDocument.activeElement);
	if (focusedInput) {
		return focusedInput;
	}

	const selector = [
		'.modal.mod-settings input[type="search"]',
		'.modal.mod-settings input[placeholder*="Filter" i]',
		'.modal.mod-settings input[placeholder*="Search" i]',
		'.modal.mod-settings input[type="text"]',
	].join(', ');

	for (const element of Array.from(activeDocument.querySelectorAll(selector))) {
		const inputEl = asTextInput(element);
		if (inputEl && isVisible(inputEl)) {
			return inputEl;
		}
	}

	return null;
}

function asTextInput(
	element: Element | null,
): HTMLInputElement | HTMLTextAreaElement | null {
	if (
		element instanceof HTMLInputElement &&
		['', 'search', 'text'].includes(element.type)
	) {
		return element;
	}

	if (element instanceof HTMLTextAreaElement) {
		return element;
	}

	return null;
}

function setTextInputValue(
	inputEl: HTMLInputElement | HTMLTextAreaElement,
	value: string,
): void {
	inputEl.focus();
	inputEl.value = value;
	inputEl.dispatchEvent(
		new InputEvent('input', {
			bubbles: true,
			cancelable: true,
			data: value,
			inputType: 'insertText',
		}),
	);
	inputEl.dispatchEvent(new Event('change', { bubbles: true }));

	const cursorPosition = value.length;
	inputEl.setSelectionRange(cursorPosition, cursorPosition);
}

function isVisible(element: HTMLElement): boolean {
	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

function waitForNextFrame(): Promise<void> {
	return new Promise((resolve) => {
		window.requestAnimationFrame(() => {
			resolve();
		});
	});
}

function showHotkeySetupNotice(
	commandCopied: boolean,
	hotkeysOpened: boolean,
	searchFilled: boolean,
): void {
	if (hotkeysOpened && searchFilled) {
		new Notice(
			`Opened Hotkeys and filtered to "${REPHRASE_COMMAND_NAME}". Press +, choose your shortcut, then save.`,
			HOTKEY_SETUP_NOTICE_DURATION_MS,
		);
		return;
	}

	if (hotkeysOpened && commandCopied) {
		new Notice(
			`Opened Hotkeys and copied "${REPHRASE_COMMAND_NAME}". Paste it in search, press +, choose your shortcut, then save.`,
			HOTKEY_SETUP_NOTICE_DURATION_MS,
		);
		return;
	}

	if (hotkeysOpened) {
		new Notice(
			`Opened Hotkeys. Search for "${REPHRASE_COMMAND_NAME}", press +, choose your shortcut, then save.`,
			HOTKEY_SETUP_NOTICE_DURATION_MS,
		);
		return;
	}

	if (commandCopied) {
		new Notice(
			`Copied "${REPHRASE_COMMAND_NAME}". Open Settings > Hotkeys, paste it in search, press +, choose your shortcut, then save.`,
			HOTKEY_SETUP_NOTICE_DURATION_MS,
		);
		return;
	}

	new Notice(
		`Open Settings > Hotkeys, search for "${REPHRASE_COMMAND_NAME}", press +, choose your shortcut, then save.`,
		HOTKEY_SETUP_NOTICE_DURATION_MS,
	);
}
