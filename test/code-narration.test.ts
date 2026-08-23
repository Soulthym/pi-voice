import assert from "node:assert/strict";
import test from "node:test";
import { chunkCodeNarration, parseCodeNarration } from "../src/code-narration.js";
import { buildCodeTargetCatalog } from "../src/code-targets.js";
import { NarrationProgress } from "../src/narration-progress.js";

const code = "const total = price + tax;\nreturn total;";

test("parses compact control-and-speech records", () => {
	const plan = parseCodeNarration(
		[
			"L+sum:1|We first",
			"B+value:1:7-11|calculate the total",
			"B-value,L-sum,L+return:2|then return it",
		].join("\n"),
		code,
	);
	assert.ok(plan?.guided);
	assert.deepEqual(plan?.records[1], {
		operations: [
			{
				kind: "bold-add",
				id: "value",
				range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 11 },
			},
		],
		speech: "calculate the total",
	});
	const chunks = chunkCodeNarration(plan!);
	assert.equal(chunks.map(chunk => chunk.text).join(" "), "We first calculate the total then return it");
	assert.ok(chunks.at(-1)?.cues.some(cue => cue.operations.some(operation => operation.kind === "reset")));
});

test("resolves Tree-sitter handles to exact source ranges", async () => {
	const targetCode = "const total = items.reduce((sum, item) => sum + item.price, 0);";
	const catalog = await buildCodeTargetCatalog("ts", targetCode);
	assert.ok(catalog);
	const declaration = catalog.targets.find(target => target.kind === "line" && target.preview.startsWith("const total"));
	const call = catalog.targets.find(target => target.kind === "span" && target.nodeType === "call_expression");
	assert.ok(declaration && call);
	const plan = parseCodeNarration(
		`L+calc:@${declaration.id}|We first\nB+sum:@${call.id}|sum all items`,
		targetCode,
		catalog.targets,
	);
	assert.deepEqual(plan?.records[0]?.operations[0], {
		kind: "line-add",
		id: "calc",
		range: { startLine: 1, endLine: 1 },
	});
	assert.deepEqual(plan?.records[1]?.operations[0], {
		kind: "bold-add",
		id: "sum",
		range: { startLine: 1, startColumn: 15, endLine: 1, endColumn: 62 },
	});
	assert.equal(parseCodeNarration("B+sum:1:15-62|sum all items", targetCode, catalog.targets), undefined);
});

test("converts Tree-sitter byte columns for Unicode source", async () => {
	const unicodeCode = 'const café = "😀" + total;';
	const catalog = await buildCodeTargetCatalog("typescript", unicodeCode);
	const total = catalog?.targets.find(
		target => target.kind === "span" && target.nodeType === "identifier" && target.preview === "total",
	);
	assert.ok(total?.kind === "span");
	assert.equal(unicodeCode.slice(total.range.startColumn - 1, total.range.endColumn), "total");
});

test("rejects malformed controls and out-of-range locations", () => {
	assert.equal(parseCodeNarration("L+sum:9|Explain it", code), undefined);
	assert.equal(parseCodeNarration("not a record", code), undefined);
	assert.equal(parseCodeNarration("B+x:1:99-100|Explain it", code), undefined);
});

test("dims code, reveals line groups, bolds spans, and restores the block", () => {
	const markdown = `\`\`\`ts\n${code}\n\`\`\``;
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, markdown);
	progress.registerSegment({
		id: 1,
		utterance: 1,
		text: "Explain total",
		source: { start: 0, end: 0 },
		revealAtEnd: true,
		code: {
			blockSource: { start: 0, end: markdown.length },
			code,
			language: "ts",
			cues: [
				{
					offset: 0,
					operations: [
						{ kind: "line-add", id: "sum", range: { startLine: 1, endLine: 1 } },
						{
							kind: "bold-add",
							id: "total",
							range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 11 },
						},
					],
				},
				{ offset: "Explain total".length, operations: [{ kind: "reset" }] },
			],
		},
	});
	progress.setSegmentAudio(1, 0, 2);
	progress.setPlayback(1, 0);
	const syntax = (source: string): string[] => source.split("\n").map(line => `\x1b[31m${line}\x1b[39m`);
	const focused = progress.transform(markdown, "assistant", text => text, text => text, () => undefined, true, syntax);
	assert.match(focused, /\x1b\[31mconst \x1b\[1mtotal\x1b\[22m = price/);
	assert.match(focused, /\x1b\[2m\x1b\[31mreturn total;\x1b\[39m\x1b\[22m/);

	progress.setPlayback(1, 2.1);
	assert.equal(progress.transform(markdown, "assistant", text => text), markdown);
});
