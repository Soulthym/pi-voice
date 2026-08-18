import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type { CodeLineRange, CodeSpanRange } from "./code-narration.js";

type TargetBase = {
	id: string;
	nodeType: string;
	line: number;
	preview: string;
};

export type CodeNarrationTarget =
	| (TargetBase & { kind: "line"; range: CodeLineRange })
	| (TargetBase & { kind: "span"; range: CodeSpanRange });

export interface CodeTargetCatalog {
	targets: CodeNarrationTarget[];
	prompt: string;
}

const require = createRequire(import.meta.url);
const grammarRoot = path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
const languagePromises = new Map<string, Promise<Language>>();
let initialized: Promise<void> | undefined;

const GRAMMARS: Record<string, string> = {
	js: "javascript",
	javascript: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	typescript: "typescript",
	tsx: "tsx",
	mts: "typescript",
	cts: "typescript",
};

const LINE_TYPES = /(?:^|_)(?:declaration|statement|clause)$|^(?:lexical_declaration|method_definition)$/;
const EXCLUDED_SPAN_TYPES = new Set(["program", "comment", "statement_block"]);
const MAX_LINE_TARGETS = 24;
const MAX_SPAN_TARGETS = 56;

async function loadLanguage(grammar: string): Promise<Language> {
	initialized ??= Parser.init();
	await initialized;
	let pending = languagePromises.get(grammar);
	if (!pending) {
		pending = Language.load(path.join(grammarRoot, `tree-sitter-${grammar}.wasm`));
		languagePromises.set(grammar, pending);
	}
	return pending;
}

function lineRange(node: SyntaxNode): CodeLineRange {
	const endsAtLineStart = node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row;
	return {
		startLine: node.startPosition.row + 1,
		endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + (endsAtLineStart ? 0 : 1)),
	};
}

function spanRange(node: SyntaxNode): CodeSpanRange {
	return {
		startLine: node.startPosition.row + 1,
		startColumn: node.startPosition.column + 1,
		endLine: node.endPosition.row + 1,
		// String parsing exposes UTF-16 columns; Tree-sitter's end is already exclusive for JS slicing.
		endColumn: node.endPosition.column,
	};
}

function preview(node: SyntaxNode, code: string): string {
	return code
		.slice(node.startIndex, node.endIndex)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 72);
}

function collectNodes(root: SyntaxNode): SyntaxNode[] {
	const nodes: SyntaxNode[] = [];
	const visit = (node: SyntaxNode): void => {
		for (const child of node.namedChildren) {
			nodes.push(child);
			visit(child);
		}
	};
	visit(root);
	return nodes;
}

function catalogPrompt(targets: CodeNarrationTarget[]): string {
	return targets
		.map(target => {
			const role = target.kind === "line" ? "L" : "B";
			return `@${target.id} ${role} line${target.line} ${target.nodeType} ${JSON.stringify(target.preview)}`;
		})
		.join("\n");
}

/** Parse an isolated JS/TS fence and expose compact, exact syntax-node handles to the narration model. */
export async function buildCodeTargetCatalog(language: string, code: string): Promise<CodeTargetCatalog | undefined> {
	const grammar = GRAMMARS[language.trim().toLowerCase()];
	if (!grammar || !code.trim()) return undefined;
	const parserLanguage = await loadLanguage(grammar);
	const parser = new Parser();
	let tree: ReturnType<Parser["parse"]> | undefined;
	try {
		parser.setLanguage(parserLanguage);
		tree = parser.parse(code);
		if (!tree) return undefined;
		const nodes = collectNodes(tree.rootNode);
		const targets: CodeNarrationTarget[] = [];
		const lineSeen = new Set<string>();
		let lineId = 0;
		for (const node of nodes) {
			if (!LINE_TYPES.test(node.type) || node.endIndex <= node.startIndex) continue;
			const range = lineRange(node);
			const key = `${range.startLine}:${range.endLine}`;
			if (lineSeen.has(key)) continue;
			lineSeen.add(key);
			lineId += 1;
			targets.push({
				id: `l${lineId}`,
				kind: "line",
				nodeType: node.type,
				line: range.startLine,
				preview: preview(node, code),
				range,
			});
			if (lineId >= MAX_LINE_TARGETS) break;
		}
		const spanSeen = new Set<string>();
		let spanId = 0;
		for (const node of nodes) {
			if (EXCLUDED_SPAN_TYPES.has(node.type) || node.endIndex <= node.startIndex) continue;
			const text = preview(node, code);
			if (!text || text.length > 72) continue;
			const key = `${node.startIndex}:${node.endIndex}`;
			if (spanSeen.has(key)) continue;
			spanSeen.add(key);
			spanId += 1;
			targets.push({
				id: `n${spanId}`,
				kind: "span",
				nodeType: node.type,
				line: node.startPosition.row + 1,
				preview: text,
				range: spanRange(node),
			});
			if (spanId >= MAX_SPAN_TARGETS) break;
		}
		if (!targets.some(target => target.kind === "line") || !targets.some(target => target.kind === "span")) {
			return undefined;
		}
		return { targets, prompt: catalogPrompt(targets) };
	} finally {
		tree?.delete();
		parser.delete();
	}
}
