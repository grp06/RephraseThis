import { Editor, MarkdownFileInfo, MarkdownView, Notice } from 'obsidian';
import {
	captureSelection,
	replaceSelectionSnapshot,
	StaleSelectionError,
} from './editor-context';
import {
	ChatCompletionsClient,
	getRephraseApiErrorMessage,
	RephraseInput,
} from './chat-completions';
import { RephrasePicker } from './rephrase-picker';
import type RephraseThisPlugin from './main';
import { resolveChatCompletionsSettings } from './settings';

export class RephraseFlow {
	private activePicker: RephrasePicker | null = null;
	private requestId = 0;

	constructor(private readonly plugin: RephraseThisPlugin) {}

	get active(): boolean {
		return this.activePicker !== null;
	}

	async run(editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> {
		const currentRequestId = this.nextRequest();
		const snapshot = captureSelection(
			editor,
			ctx,
			this.plugin.settings.contextChars,
		);

		if (!snapshot) {
			new Notice('Select text to rephrase.');
			return;
		}

		const picker = new RephrasePicker(snapshot.anchorRect);
		this.activePicker = picker;
		picker.showLoading();

		try {
			const client = new ChatCompletionsClient(
				resolveChatCompletionsSettings(this.plugin.app, this.plugin.settings),
			);
			const input: RephraseInput = {
				noteTitle: snapshot.noteTitle,
				before: snapshot.before,
				selectedText: snapshot.selectedText,
				after: snapshot.after,
			};
			const result = await client.rephrase(input, { count: 1 });

			if (currentRequestId !== this.requestId || picker.closed) {
				picker.close();
				return;
			}

			const initialSuggestion = result.alternatives[0];
			if (!initialSuggestion) {
				throw new Error('No rephrase suggestion was returned.');
			}

			const choicePromise = picker.choose(initialSuggestion);
			void this.loadMoreSuggestions(
				currentRequestId,
				picker,
				client,
				input,
				initialSuggestion,
			);
			const choice = await choicePromise;
			if (!choice || currentRequestId !== this.requestId) {
				return;
			}

			try {
				replaceSelectionSnapshot(editor, snapshot, choice.value);
			} catch (error) {
				if (error instanceof StaleSelectionError) {
					new Notice(error.message);
					return;
				}

				throw error;
			}
		} catch (error) {
			if (currentRequestId === this.requestId) {
				new Notice(getRephraseApiErrorMessage(error));
			}
		} finally {
			if (this.activePicker === picker) {
				picker.close();
				this.activePicker = null;
			}
		}
	}

	unload(): void {
		this.requestId += 1;
		this.activePicker?.close();
		this.activePicker = null;
	}

	private nextRequest(): number {
		this.requestId += 1;
		this.activePicker?.close();
		this.activePicker = null;
		return this.requestId;
	}

	private async loadMoreSuggestions(
		requestId: number,
		picker: RephrasePicker,
		client: ChatCompletionsClient,
		input: RephraseInput,
		initialSuggestion: string,
	): Promise<void> {
		picker.setMoreSuggestionsLoading(true);

		try {
			const result = await client.rephrase(input, {
				count: 4,
				avoidAlternatives: [initialSuggestion],
			});

			if (requestId !== this.requestId || picker.closed) {
				return;
			}

			picker.addSuggestions(result.alternatives);
		} catch (error) {
			if (requestId === this.requestId && !picker.closed) {
				console.warn('[RephraseThis] Failed to preload more suggestions', error);
			}
		} finally {
			if (requestId === this.requestId && !picker.closed) {
				picker.setMoreSuggestionsLoading(false);
			}
		}
	}
}
