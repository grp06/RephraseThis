import {
	App,
	Component,
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
} from 'obsidian';
import { captureSelection, SelectionSnapshot } from './editor-context';
import {
	getRephraseConfigurationWarning,
	type RephraseConfigurationWarning,
	type RephraseThisSettings,
} from './settings';

const SELECTION_BUTTON_DELAY_MS = 400;
const MAX_SELECTION_CHARS = 4000;
const VIEWPORT_MARGIN = 8;

interface SelectionTriggerOptions {
	app: App;
	settings: RephraseThisSettings;
	isRephraseActive: () => boolean;
	runRephrase: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => void;
}

interface SelectionCandidate {
	editor: Editor;
	ctx: MarkdownView | MarkdownFileInfo;
	fingerprint: string;
	rect: DOMRect;
	warning: RephraseConfigurationWarning | null;
}

export class SelectionTriggerController extends Component {
	private buttonEl: HTMLButtonElement | null = null;
	private buttonFingerprint: string | null = null;
	private currentFingerprint: string | null = null;
	private consumedFingerprint: string | null = null;
	private pendingFingerprint: string | null = null;
	private delayTimer: number | null = null;

	constructor(private readonly options: SelectionTriggerOptions) {
		super();
	}

	onload(): void {
		this.registerDomEvent(activeDocument, 'selectionchange', () => {
			this.handleSelectionUpdate();
		});
		this.registerDomEvent(activeDocument, 'keyup', () => {
			this.handleSelectionUpdate();
		});
		this.registerDomEvent(activeDocument, 'pointerup', () => {
			this.handleSelectionUpdate();
		});
		this.registerDomEvent(activeWindow, 'resize', () => {
			this.handleSelectionUpdate();
		});
		this.registerEvent(
			this.options.app.workspace.on('active-leaf-change', () => {
				this.clearSelectionState();
			}),
		);
	}

	onunload(): void {
		this.clearDelayTimer();
		this.removeButton();
	}

	private handleSelectionUpdate(): void {
		if (this.options.isRephraseActive()) {
			this.clearDelayTimer();
			this.removeButton();
			return;
		}

		const candidate = this.readCandidate();
		if (!candidate) {
			this.clearSelectionState();
			return;
		}

		if (candidate.fingerprint !== this.currentFingerprint) {
			this.currentFingerprint = candidate.fingerprint;
			this.consumedFingerprint = null;
		}

		if (candidate.fingerprint === this.consumedFingerprint) {
			this.clearDelayTimer();
			this.removeButton();
			return;
		}

		if (candidate.fingerprint === this.buttonFingerprint) {
			this.updateButtonCopy(candidate.warning);
			this.positionButton(candidate);
			return;
		}

		if (candidate.fingerprint === this.pendingFingerprint) {
			return;
		}

		this.pendingFingerprint = candidate.fingerprint;
		this.clearDelayTimer();
		this.removeButton();
		this.delayTimer = window.setTimeout(() => {
			this.showIfSelectionIsStable(candidate.fingerprint);
		}, SELECTION_BUTTON_DELAY_MS);
	}

	private showIfSelectionIsStable(fingerprint: string): void {
		this.delayTimer = null;

		const candidate = this.readCandidate();
		if (!candidate || candidate.fingerprint !== fingerprint) {
			return;
		}

		this.showButton(candidate);
	}

	private readCandidate(): SelectionCandidate | null {
		if (!this.options.settings.showSelectionRephraseButton) {
			return null;
		}

		const ctx = this.options.app.workspace.activeEditor;
		const editor = ctx?.editor;
		if (!ctx || !editor) {
			return null;
		}

		const snapshot = captureSelection(
			editor,
			ctx,
			this.options.settings.contextChars,
		);
		if (!snapshot || !snapshot.anchorRect) {
			return null;
		}

		if (snapshot.selectedText.length > MAX_SELECTION_CHARS) {
			return null;
		}

		return {
			editor,
			ctx,
			fingerprint: this.fingerprint(ctx, editor, snapshot),
			rect: snapshot.anchorRect,
			warning: getRephraseConfigurationWarning(
				this.options.app,
				this.options.settings,
			),
		};
	}

	private fingerprint(
		ctx: MarkdownFileInfo,
		editor: Editor,
		snapshot: SelectionSnapshot,
	): string {
		const filePath = ctx.file?.path ?? '';
		const fromOffset = editor.posToOffset(snapshot.from);
		const toOffset = editor.posToOffset(snapshot.to);
		return `${filePath}:${fromOffset}:${toOffset}:${snapshot.selectedText}`;
	}

	private showButton(candidate: SelectionCandidate): void {
		const buttonEl = this.ensureButton();
		this.buttonFingerprint = candidate.fingerprint;
		buttonEl.classList.add('is-positioning');
		this.updateButtonCopy(candidate.warning);
		this.positionButton(candidate);
		buttonEl.classList.remove('is-positioning');
	}

	private ensureButton(): HTMLButtonElement {
		if (this.buttonEl) {
			return this.buttonEl;
		}

		const buttonEl = activeDocument.createElement('button');
		buttonEl.type = 'button';
		buttonEl.className = 'rephrasethis-selection-trigger is-positioning';
		this.updateButtonCopy(null);
		this.registerDomEvent(buttonEl, 'pointerdown', (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		this.registerDomEvent(buttonEl, 'click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.handleButtonClick();
		});
		activeDocument.body.appendChild(buttonEl);
		this.buttonEl = buttonEl;
		return buttonEl;
	}

	private updateButtonCopy(warning: RephraseConfigurationWarning | null): void {
		if (!this.buttonEl) {
			return;
		}

		this.buttonEl.textContent = warning?.buttonText ?? 'Rephrase';
		this.buttonEl.setAttribute(
			'aria-label',
			warning?.ariaLabel ?? 'Rephrase selection',
		);
		this.buttonEl.classList.toggle(
			'rephrasethis-selection-trigger-has-warning',
			warning !== null,
		);
	}

	private positionButton(candidate: SelectionCandidate): void {
		if (!this.buttonEl) {
			return;
		}

		const buttonRect = this.buttonEl.getBoundingClientRect();
		const width = buttonRect.width;
		const height = buttonRect.height;
		const top = candidate.rect.top - height - 6;
		const fallbackTop = candidate.rect.bottom + 6;
		const resolvedTop = top >= VIEWPORT_MARGIN ? top : fallbackTop;
		const maxLeft = Math.max(
			VIEWPORT_MARGIN,
			activeWindow.innerWidth - width - VIEWPORT_MARGIN,
		);
		const maxTop = Math.max(
			VIEWPORT_MARGIN,
			activeWindow.innerHeight - height - VIEWPORT_MARGIN,
		);
		const left = clamp(candidate.rect.left, VIEWPORT_MARGIN, maxLeft);

		this.buttonEl.style.left = `${left}px`;
		this.buttonEl.style.top = `${clamp(
			resolvedTop,
			VIEWPORT_MARGIN,
			maxTop,
		)}px`;
	}

	private handleButtonClick(): void {
		const candidate = this.readCandidate();
		if (!candidate) {
			this.removeButton();
			return;
		}

		if (candidate.warning) {
			new Notice(candidate.warning.noticeText);
			this.showButton(candidate);
			return;
		}

		this.consumedFingerprint = candidate.fingerprint;
		this.pendingFingerprint = null;
		this.clearDelayTimer();
		this.removeButton();
		this.options.runRephrase(candidate.editor, candidate.ctx);
	}

	private clearSelectionState(): void {
		this.currentFingerprint = null;
		this.consumedFingerprint = null;
		this.pendingFingerprint = null;
		this.clearDelayTimer();
		this.removeButton();
	}

	private removeButton(): void {
		this.buttonEl?.remove();
		this.buttonEl = null;
		this.buttonFingerprint = null;
	}

	private clearDelayTimer(): void {
		if (this.delayTimer === null) {
			return;
		}

		window.clearTimeout(this.delayTimer);
		this.delayTimer = null;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
