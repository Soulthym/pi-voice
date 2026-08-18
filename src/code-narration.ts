export interface CodeLineRange {
	startLine: number;
	endLine: number;
}

export interface CodeSpanRange extends CodeLineRange {
	startColumn: number;
	endColumn: number;
}

export type CodeNarrationOperation =
	| { kind: "line-add"; id: string; range: CodeLineRange }
	| { kind: "line-remove"; id: string }
	| { kind: "bold-add"; id: string; range: CodeSpanRange }
	| { kind: "bold-remove"; id: string }
	| { kind: "reset" };

export interface CodeNarrationRecord {
	operations: CodeNarrationOperation[];
	speech: string;
}

export interface CodeNarrationPlan {
	records: CodeNarrationRecord[];
	guided: boolean;
}

export interface CodeNarrationCue {
	offset: number;
	operations: CodeNarrationOperation[];
}

export interface CodeNarrationChunk {
	text: string;
	cues: CodeNarrationCue[];
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;
const MAX_RECORDS = 32;
const MAX_OPERATIONS = 8;
const MAX_SPEECH = 1_500;
const MAX_CHUNK = 260;

function lineRange(value: string, lineCount: number): CodeLineRange | undefined {
	const match = /^(\d+)(?:-(\d+))?$/.exec(value);
	if (!match) return undefined;
	const startLine = Number(match[1]);
	const endLine = Number(match[2] ?? match[1]);
	return startLine >= 1 && endLine >= startLine && endLine <= lineCount ? { startLine, endLine } : undefined;
}

function spanRange(value: string, lines: string[]): CodeSpanRange | undefined {
	const full = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(value);
	const sameLine = /^(\d+):(\d+)-(\d+)$/.exec(value);
	const startLine = Number(full?.[1] ?? sameLine?.[1]);
	const startColumn = Number(full?.[2] ?? sameLine?.[2]);
	const endLine = Number(full?.[3] ?? sameLine?.[1]);
	const endColumn = Number(full?.[4] ?? sameLine?.[3]);
	if (
		!Number.isInteger(startLine) ||
		!Number.isInteger(startColumn) ||
		!Number.isInteger(endLine) ||
		!Number.isInteger(endColumn) ||
		startLine < 1 ||
		endLine < startLine ||
		endLine > lines.length ||
		startColumn < 1 ||
		endColumn < 1 ||
		(startLine === endLine && endColumn < startColumn)
	) {
		return undefined;
	}
	const startLength = lines[startLine - 1]?.length ?? 0;
	const endLength = lines[endLine - 1]?.length ?? 0;
	if (startColumn > startLength + 1 || endColumn > endLength + 1) return undefined;
	return { startLine, startColumn, endLine, endColumn };
}

function operation(value: string, lines: string[]): CodeNarrationOperation | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "-") return undefined;
	let match = /^L\+([A-Za-z][A-Za-z0-9_-]{0,15}):(\d+(?:-\d+)?)$/.exec(trimmed);
	if (match && ID_RE.test(match[1])) {
		const range = lineRange(match[2], lines.length);
		return range ? { kind: "line-add", id: match[1], range } : undefined;
	}
	match = /^L-([A-Za-z][A-Za-z0-9_-]{0,15})$/.exec(trimmed);
	if (match) return { kind: "line-remove", id: match[1] };
	match = /^B\+([A-Za-z][A-Za-z0-9_-]{0,15}):(.+)$/.exec(trimmed);
	if (match && ID_RE.test(match[1])) {
		const range = spanRange(match[2], lines);
		return range ? { kind: "bold-add", id: match[1], range } : undefined;
	}
	match = /^B-([A-Za-z][A-Za-z0-9_-]{0,15})$/.exec(trimmed);
	if (match) return { kind: "bold-remove", id: match[1] };
	return undefined;
}

export function parseCodeNarration(text: string, code: string): CodeNarrationPlan | undefined {
	const cleaned = text
		.trim()
		.replace(/^```(?:text)?\s*\n?/i, "")
		.replace(/\n?```$/, "")
		.trim();
	if (!cleaned) return undefined;
	const sourceLines = code.split(/\r?\n/);
	const rows = cleaned.split(/\r?\n/).filter(row => row.trim().length > 0);
	if (rows.length === 0 || rows.length > MAX_RECORDS) return undefined;
	const records: CodeNarrationRecord[] = [];
	let speechLength = 0;
	let hasHighlight = false;
	for (const row of rows) {
		const separator = row.indexOf("|");
		if (separator < 0) return undefined;
		const control = row.slice(0, separator).trim();
		const speech = row.slice(separator + 1).trim();
		if (speech.length > MAX_CHUNK) return undefined;
		const controls = !control || control === "-" ? [] : control.split(",").map(item => item.trim()).filter(Boolean);
		if (controls.length > MAX_OPERATIONS) return undefined;
		const operations: CodeNarrationOperation[] = [];
		for (const item of controls) {
			const parsed = operation(item, sourceLines);
			if (!parsed) return undefined;
			operations.push(parsed);
			if (parsed.kind === "line-add" || parsed.kind === "bold-add") hasHighlight = true;
		}
		speechLength += speech.length;
		if (speechLength > MAX_SPEECH) return undefined;
		records.push({ operations, speech });
	}
	if (!records.some(record => record.speech) || !hasHighlight) return undefined;
	return { records, guided: true };
}

export function plainCodeNarration(speech: string): CodeNarrationPlan {
	return { records: [{ operations: [], speech }], guided: false };
}

export function chunkCodeNarration(plan: CodeNarrationPlan): CodeNarrationChunk[] {
	const chunks: CodeNarrationChunk[] = [];
	let text = "";
	let cues: CodeNarrationCue[] = [];
	const flush = (): void => {
		if (!text.trim()) return;
		chunks.push({ text: text.trim(), cues });
		text = "";
		cues = [];
	};
	for (const record of plan.records) {
		const joiner = text && record.speech ? " " : "";
		if (record.speech && text.length + joiner.length + record.speech.length > MAX_CHUNK) flush();
		const offset = text.length + (text && record.speech ? 1 : 0);
		if (record.operations.length > 0) cues.push({ offset, operations: record.operations });
		if (record.speech) text += `${text ? " " : ""}${record.speech}`;
	}
	if (plan.guided) cues.push({ offset: text.length, operations: [{ kind: "reset" }] });
	flush();
	if (plan.guided && chunks.length > 1) {
		// Move the automatic reset to the final chunk.
		for (const chunk of chunks.slice(0, -1)) {
			chunk.cues = chunk.cues.filter(cue => !cue.operations.some(operation => operation.kind === "reset"));
		}
		const last = chunks[chunks.length - 1];
		if (!last.cues.some(cue => cue.operations.some(operation => operation.kind === "reset"))) {
			last.cues.push({ offset: last.text.length, operations: [{ kind: "reset" }] });
		}
	}
	return chunks;
}
