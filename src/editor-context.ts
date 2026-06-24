import {
	Editor,
	EditorPosition,
	MarkdownFileInfo,
	MarkdownView,
} from 'obsidian';

export interface SelectionSnapshot {
	noteTitle: string;
	selectedText: string;
	before: string;
	after: string;
	from: EditorPosition;
	to: EditorPosition;
	anchorRect: DOMRect | null;
}

export class StaleSelectionError extends Error {
	constructor() {
		super('The selected text changed. Try rephrasing it again.');
		this.name = 'StaleSelectionError';
	}
}

export function captureSelection(
	editor: Editor,
	ctx: MarkdownView | MarkdownFileInfo,
	contextChars: number,
): SelectionSnapshot | null {
	const selection = editor.listSelections()[0];
	if (!selection) {
		return null;
	}

	const anchorOffset = editor.posToOffset(selection.anchor);
	const headOffset = editor.posToOffset(selection.head);
	if (anchorOffset === headOffset) {
		return null;
	}

	const from = anchorOffset < headOffset ? selection.anchor : selection.head;
	const to = anchorOffset < headOffset ? selection.head : selection.anchor;
	const fromOffset = Math.min(anchorOffset, headOffset);
	const toOffset = Math.max(anchorOffset, headOffset);
	const selectedText = editor.getRange(from, to);

	if (selectedText.trim().length === 0) {
		return null;
	}

	const noteText = editor.getValue();
	const surroundingChars = Math.max(0, Math.floor(contextChars));

	return {
		noteTitle: ctx.file?.basename ?? '',
		selectedText,
		before: noteText.slice(Math.max(0, fromOffset - surroundingChars), fromOffset),
		after: noteText.slice(toOffset, toOffset + surroundingChars),
		from,
		to,
		anchorRect: captureBrowserSelectionRect(),
	};
}

export function replaceSelectionSnapshot(
	editor: Editor,
	snapshot: SelectionSnapshot,
	replacement: string,
): void {
	const currentText = editor.getRange(snapshot.from, snapshot.to);
	if (currentText !== snapshot.selectedText) {
		editor.setSelection(snapshot.from, snapshot.to);
		throw new StaleSelectionError();
	}

	const fromOffset = editor.posToOffset(snapshot.from);
	editor.replaceRange(
		replacement,
		snapshot.from,
		snapshot.to,
		'rephrasethis-rephrase',
	);
	editor.focus();
	editor.setCursor(editor.offsetToPos(fromOffset + replacement.length));
}

function captureBrowserSelectionRect(): DOMRect | null {
	const selection = activeWindow.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return null;
	}

	const range = selection.getRangeAt(0);
	const rect = firstVisibleRect(range);
	if (!rect) {
		return null;
	}

	return cloneRect(rect);
}

function firstVisibleRect(range: Range): DOMRect | null {
	for (const rect of Array.from(range.getClientRects())) {
		if (rect.width > 0 && rect.height > 0) {
			return cloneRect(rect);
		}
	}

	const fallback = range.getBoundingClientRect();
	if (fallback.width > 0 && fallback.height > 0) {
		return cloneRect(fallback);
	}

	return null;
}

function cloneRect(rect: DOMRect | DOMRectReadOnly): DOMRect {
	return new DOMRect(rect.x, rect.y, rect.width, rect.height);
}
