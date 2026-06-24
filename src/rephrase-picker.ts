import { Component, setIcon } from 'obsidian';

const VIEWPORT_MARGIN = 16;
const FALLBACK_WIDTH = 520;
const FALLBACK_HEIGHT = 48;

export interface RephrasePickerChoice {
	value: string;
	index: number;
}

export class RephrasePicker extends Component {
	private rootEl: HTMLElement | null = null;
	private lineEl: HTMLElement | null = null;
	private suggestionTextEl: HTMLElement | null = null;
	private actionsEl: HTMLElement | null = null;
	private keyboardHintEl: HTMLElement | null = null;
	private counterEl: HTMLElement | null = null;
	private closeButtonEl: HTMLButtonElement | null = null;
	private alternatives: string[] = [];
	private selectedIndex = 0;
	private moreSuggestionsLoading = false;
	private resolveChoice: ((choice: RephrasePickerChoice | null) => void) | null =
		null;
	private settled = false;

	constructor(private readonly anchorRect: DOMRect | null) {
		super();
	}

	get closed(): boolean {
		return this.settled || !this.rootEl;
	}

	showLoading(): void {
		this.renderShell();
		this.renderLoading();
	}

	choose(initialSuggestion: string): Promise<RephrasePickerChoice | null> {
		if (this.settled) {
			return Promise.resolve(null);
		}

		this.alternatives = [initialSuggestion];
		this.selectedIndex = 0;
		this.renderShell();
		this.renderSuggestion();

		return new Promise((resolve) => {
			this.resolveChoice = resolve;
		});
	}

	addSuggestions(suggestions: string[]): void {
		if (this.settled) {
			return;
		}

		const knownSuggestions = new Set(this.alternatives.map(normalizeSuggestion));
		const newSuggestions = suggestions.filter((suggestion) => {
			const normalizedSuggestion = normalizeSuggestion(suggestion);
			if (!normalizedSuggestion || knownSuggestions.has(normalizedSuggestion)) {
				return false;
			}

			knownSuggestions.add(normalizedSuggestion);
			return true;
		});

		this.alternatives.push(...newSuggestions);
		this.updateFooter();
	}

	setMoreSuggestionsLoading(isLoading: boolean): void {
		if (this.settled) {
			return;
		}

		this.moreSuggestionsLoading = isLoading;
		this.updateFooter();
	}

	close(): void {
		this.finish(null);
	}

	onunload(): void {
		this.resolveChoice?.(null);
		this.resolveChoice = null;
		this.rootEl?.remove();
		this.rootEl = null;
		this.lineEl = null;
		this.suggestionTextEl = null;
		this.actionsEl = null;
		this.keyboardHintEl = null;
		this.counterEl = null;
		this.closeButtonEl = null;
		this.settled = true;
	}

	private renderShell(): void {
		if (this.settled) {
			return;
		}

		if (!this.rootEl) {
			this.load();
			this.rootEl = activeDocument.createElement('div');
			this.rootEl.className = 'rephrasethis-rephrase-popover';
			this.rootEl.setAttribute('role', 'dialog');
			this.rootEl.setAttribute('aria-label', 'Rephrase suggestion');
			activeDocument.body.appendChild(this.rootEl);
			this.registerDomEvent(activeDocument, 'keydown', this.handleKeydown, true);
			this.registerDomEvent(activeWindow, 'resize', () => {
				this.position();
			});
			this.registerDomEvent(
				activeDocument,
				'pointerdown',
				this.handlePointerDown,
				true,
			);
		}

		this.rootEl.replaceChildren();
		const ghostEl = activeDocument.createElement('div');
		ghostEl.className = 'rephrasethis-rephrase-ghost';

		this.closeButtonEl = activeDocument.createElement('button');
		this.closeButtonEl.type = 'button';
		this.closeButtonEl.className = 'rephrasethis-rephrase-close';
		this.closeButtonEl.setAttribute('aria-label', 'Close suggestion');
		this.closeButtonEl.title = 'Close suggestion';
		setIcon(this.closeButtonEl, 'x');
		this.registerDomEvent(this.closeButtonEl, 'click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.close();
		});

		this.lineEl = activeDocument.createElement('div');
		this.lineEl.className = 'rephrasethis-rephrase-line';

		this.suggestionTextEl = activeDocument.createElement('span');
		this.suggestionTextEl.className = 'rephrasethis-rephrase-suggestion';
		this.suggestionTextEl.setAttribute('aria-live', 'polite');

		this.actionsEl = activeDocument.createElement('div');
		this.actionsEl.className = 'rephrasethis-rephrase-actions';

		this.keyboardHintEl = activeDocument.createElement('span');
		this.keyboardHintEl.className = 'rephrasethis-rephrase-keyboard-hint';
		this.keyboardHintEl.textContent = 'Tab for more, enter to accept';

		this.counterEl = activeDocument.createElement('span');
		this.counterEl.className = 'rephrasethis-rephrase-counter';

		this.lineEl.append(this.suggestionTextEl);
		this.actionsEl.append(
			this.keyboardHintEl,
			this.counterEl,
		);

		ghostEl.append(this.closeButtonEl, this.lineEl, this.actionsEl);
		this.rootEl.append(ghostEl);
		this.updateFooter();
	}

	private renderLoading(): void {
		if (!this.suggestionTextEl) {
			return;
		}

		this.rootEl?.classList.add('rephrasethis-rephrase-is-loading');
		this.rootEl?.classList.remove('rephrasethis-rephrase-is-ready');
		this.suggestionTextEl.textContent = 'Rephrasing...';
		this.updateFooter();
		this.position();
	}

	private renderSuggestion(): void {
		if (!this.suggestionTextEl) {
			return;
		}

		this.rootEl?.classList.remove('rephrasethis-rephrase-is-loading');
		this.rootEl?.classList.add('rephrasethis-rephrase-is-ready');
		this.suggestionTextEl.textContent = this.alternatives[this.selectedIndex] ?? '';
		this.updateFooter();
		this.position();
	}

	private handleKeydown = (event: KeyboardEvent): void => {
		if (!this.rootEl) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.close();
			return;
		}

		if (event.key === 'Tab') {
			event.preventDefault();
			event.stopPropagation();
			if (this.hasSuggestion()) {
				this.cycleSuggestion();
			}
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			if (this.hasSuggestion()) {
				this.acceptCurrentSuggestion();
			}
		}
	};

	private handlePointerDown = (event: PointerEvent): void => {
		const ownerWindow = this.rootEl?.ownerDocument.defaultView;
		if (
			!this.rootEl ||
			!ownerWindow ||
			!(event.target instanceof ownerWindow.Node)
		) {
			return;
		}

		if (!this.rootEl.contains(event.target)) {
			this.close();
		}
	};

	private cycleSuggestion(): void {
		if (this.alternatives.length <= 1) {
			return;
		}

		this.selectedIndex = (this.selectedIndex + 1) % this.alternatives.length;
		this.renderSuggestion();
	}

	private acceptCurrentSuggestion(): void {
		const value = this.alternatives[this.selectedIndex];
		if (!value) {
			return;
		}

		this.finish({ value, index: this.selectedIndex });
	}

	private finish(choice: RephrasePickerChoice | null): void {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.resolveChoice?.(choice);
		this.resolveChoice = null;
		this.unload();
	}

	private hasSuggestion(): boolean {
		return this.alternatives.length > 0;
	}

	private updateFooter(): void {
		if (!this.keyboardHintEl || !this.counterEl || !this.actionsEl) {
			return;
		}

		const hasSuggestion = this.hasSuggestion();
		const showLoadingMore = hasSuggestion && this.moreSuggestionsLoading;
		this.actionsEl.hidden = !hasSuggestion;
		this.keyboardHintEl.hidden = !hasSuggestion;
		this.counterEl.hidden = !hasSuggestion;
		this.counterEl.classList.toggle('is-loading-more', showLoadingMore);
		this.counterEl.setAttribute(
			'aria-label',
			showLoadingMore
				? 'Loading more suggestions'
				: `Suggestion ${this.selectedIndex + 1} of ${this.alternatives.length}`,
		);
		this.counterEl.textContent =
			hasSuggestion && !showLoadingMore
				? `${this.selectedIndex + 1}/${this.alternatives.length}`
				: '';
		this.position();
	}

	private position(): void {
		if (!this.rootEl) {
			return;
		}

		const rect = this.rootEl.getBoundingClientRect();
		const width = rect.width || FALLBACK_WIDTH;
		const height = rect.height || FALLBACK_HEIGHT;
		const viewportWidth = activeWindow.innerWidth;
		const viewportHeight = activeWindow.innerHeight;

		if (!this.anchorRect) {
			this.applyPosition({
				left: (viewportWidth - width) / 2,
				top: viewportHeight * 0.34,
				width,
				height,
			});
			return;
		}

		const preferredTop = this.anchorRect.top - height - 6;
		const fallbackTop = this.anchorRect.bottom + 6;

		this.applyPosition({
			left: this.anchorRect.left,
			top: preferredTop >= VIEWPORT_MARGIN ? preferredTop : fallbackTop,
			width,
			height,
		});
	}

	private applyPosition(position: {
		left: number;
		top: number;
		width: number;
		height: number;
	}): void {
		if (!this.rootEl) {
			return;
		}

		const maxLeft = Math.max(
			VIEWPORT_MARGIN,
			activeWindow.innerWidth - position.width - VIEWPORT_MARGIN,
		);
		const maxTop = Math.max(
			VIEWPORT_MARGIN,
			activeWindow.innerHeight - position.height - VIEWPORT_MARGIN,
		);
		const left = clamp(position.left, VIEWPORT_MARGIN, maxLeft);
		const top = clamp(position.top, VIEWPORT_MARGIN, maxTop);

		this.rootEl.style.left = `${left}px`;
		this.rootEl.style.top = `${top}px`;
	}
}

function normalizeSuggestion(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
