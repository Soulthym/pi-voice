import assert from "node:assert/strict";
import test from "node:test";
import { plainCodeNarration, type CodeNarrationPlan } from "../src/code-narration.js";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { type CodeDescriptionSourceContext, Vocalizer } from "../src/vocalizer.js";

function immediate(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

test("shifts narration source ranges when regenerating a message suffix", () => {
	const sources: Array<{ start: number; end: number }> = [];
	const worker = {
		sendSegment(): void {},
		endUtterance(): void {},
		async measureSegment(): Promise<number> {
			return 1;
		},
		cancel(): void {},
		async transcribe(): Promise<string[]> {
			return [];
		},
		async transcribePcm(): Promise<string> {
			return "";
		},
		async preload(): Promise<void> {},
		async preloadAlignment(): Promise<void> {},
		async terminate(): Promise<void> {},
	};
	const vocalizer = new Vocalizer(
		() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }),
		() => {},
		undefined,
		segment => sources.push(segment.source),
		worker,
	);
	vocalizer.speakFrom("Replay this sentence.", 40);
	assert.deepEqual(sources, [{ start: 40, end: 61 }]);
});

test("passes pause and resume through without cancelling queued narration", () => {
	const pauses: boolean[] = [];
	let cancellations = 0;
	const worker = {
		sendSegment(): void {},
		endUtterance(): void {},
		setPlaybackPaused(paused: boolean): void {
			pauses.push(paused);
		},
		async measureSegment(): Promise<number> { return 1; },
		cancel(): void { cancellations += 1; },
		async transcribe(): Promise<string[]> { return []; },
		async transcribePcm(): Promise<string> { return ""; },
		async preload(): Promise<void> {},
		async preloadAlignment(): Promise<void> {},
		async terminate(): Promise<void> {},
	};
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {}, undefined, undefined, worker);
	vocalizer.setPlaybackPaused(true);
	vocalizer.setPlaybackPaused(false);
	assert.deepEqual(pauses, [true, false]);
	assert.equal(cancellations, 0);
});

test("speaks coordinator prompts without registering message narration", () => {
	const spoken: string[] = [];
	const narration: string[] = [];
	const worker = {
		sendSegment(_utterance: number, _segmentId: number, text: string): void {
			spoken.push(text);
		},
		endUtterance(): void {},
		async measureSegment(): Promise<number> {
			return 1;
		},
		cancel(): void {},
		async transcribe(): Promise<string[]> {
			return [];
		},
		async transcribePcm(): Promise<string> {
			return "";
		},
		async preload(): Promise<void> {},
		async preloadAlignment(): Promise<void> {},
		async terminate(): Promise<void> {},
	};
	const vocalizer = new Vocalizer(
		() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }),
		() => {},
		undefined,
		segment => narration.push(segment.text),
		worker,
	);
	assert.equal(vocalizer.speakUntracked("Project alpha."), 1);
	assert.deepEqual(spoken, ["Project alpha."]);
	assert.deepEqual(narration, []);
});

test("starts code description early while preserving spoken order", async () => {
	const events: string[] = [];
	const worker = {
		sendSegment(_utterance: number, _segmentId: number, text: string): void {
			events.push(`speech:${text}`);
		},
		endUtterance(): void {
			events.push("end");
		},
		async measureSegment(): Promise<number> {
			return 1;
		},
		cancel(): void {},
		async transcribe(): Promise<string[]> {
			return [];
		},
		async transcribePcm(): Promise<string> {
			return "";
		},
		async preload(): Promise<void> {},
		async preloadAlignment(): Promise<void> {},
		async terminate(): Promise<void> {},
	};
	const deferred = Promise.withResolvers<CodeNarrationPlan>();
	let descriptionStarted = false;
	let descriptionContext: CodeDescriptionSourceContext = { beforeBlock: "", throughBlock: "", sourceEnd: 0 };
	let allocatedUtterance: number | undefined;
	const vocalizer = new Vocalizer(
		() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }),
		() => {},
		async (_block, context) => {
			descriptionStarted = true;
			descriptionContext = context;
			return deferred.promise;
		},
		undefined,
		worker,
		utterance => {
			allocatedUtterance = utterance;
		},
	);

	const providerMessages = [{ role: "user", content: [{ type: "text", text: "Actual API context" }] }] as never;
	vocalizer.setCodeDescriptionMessages(providerMessages);
	vocalizer.pushDelta("Before.\n```ts\nconst value = 1;\n```\nAfter.");
	vocalizer.flush();

	assert.equal(descriptionStarted, true);
	assert.equal(allocatedUtterance, 1, "deferred code narration must reserve its utterance synchronously");
	assert.deepEqual(descriptionContext, {
		beforeBlock: "Before.\n",
		throughBlock: "Before.\n```ts\nconst value = 1;\n```\n",
		sourceEnd: "Before.\n```ts\nconst value = 1;\n```\n".length,
		providerMessages,
	});
	assert.deepEqual(events, ["speech:Before."]);

	deferred.resolve(plainCodeNarration("The code defines a constant value."));
	await immediate();
	await immediate();
	assert.deepEqual(events, ["speech:Before.", "speech:The code defines a constant value.", "speech:After.", "end"]);
});
