import { Notice, Plugin } from 'obsidian';
import { REPHRASE_COMMAND_ID, REPHRASE_COMMAND_NAME } from './commands';
import { RephraseFlow } from './rephrase-flow';
import { SelectionTriggerController } from './selection-trigger';
import {
	loadRephraseThisSettings,
	migrateLegacyApiKeyToSecretStorage,
	RephraseThisSettings,
	RephraseThisSettingTab,
	shouldSaveSettingsAfterSecretMigration,
} from './settings';

export default class RephraseThisPlugin extends Plugin {
	settings!: RephraseThisSettings;
	private rephraseFlow: RephraseFlow | null = null;

	async onload() {
		await this.loadSettings();
		this.rephraseFlow = new RephraseFlow(this);

		this.addChild(
			new SelectionTriggerController({
				app: this.app,
				settings: this.settings,
				isRephraseActive: () => this.rephraseFlow?.active ?? false,
				runRephrase: (editor, ctx) => {
					void this.rephraseFlow?.run(editor, ctx);
				},
			}),
		);

		this.addCommand({
			id: REPHRASE_COMMAND_ID,
			name: REPHRASE_COMMAND_NAME,
			editorCallback: (editor, ctx) => {
				void this.rephraseFlow?.run(editor, ctx);
			},
		});

		this.addSettingTab(new RephraseThisSettingTab(this.app, this));
	}

	onunload() {
		this.rephraseFlow?.unload();
		this.rephraseFlow = null;
	}

	async loadSettings() {
		const savedData: unknown = await this.loadData();
		this.settings = loadRephraseThisSettings(savedData);

		try {
			const migrated = migrateLegacyApiKeyToSecretStorage(
				this.app,
				savedData,
				this.settings,
			);

			if (migrated || shouldSaveSettingsAfterSecretMigration(savedData, this.settings)) {
				await this.saveSettings();
			}

			if (migrated) {
				new Notice('Your API key was moved to Obsidian secret storage.');
			}
		} catch (error) {
			console.warn('[RephraseThis] Failed to migrate legacy API key', error);
			new Notice(
				'Your API key could not be moved to secret storage. Re-enter it in plugin settings.',
			);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
