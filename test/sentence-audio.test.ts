import assert from "node:assert/strict";
import { test } from "node:test";
import { RawAudio, Tensor } from "@huggingface/transformers";
import { generateSentenceAudio } from "../src/sentence-audio.mjs";

test("long sentence audio retains every phoneme in order without changing the shared model", async () => {
	const lengths: number[] = [];
	const tokenizer = (_text: string, options: { truncation: boolean }) => {
		assert.equal(options.truncation, false);
		const tokens = BigInt64Array.from([0, ...Array.from({ length: 1200 }, (_, i) => i + 1), 0], BigInt);
		return { input_ids: new Tensor("int64", tokens, [1, tokens.length]) };
	};
	const model = {
		tokenizer,
		async generate(text: string, options: unknown) {
			return this.generate_from_ids(this.tokenizer(text, { truncation: true }).input_ids, options);
		},
		async generate_from_ids(ids: Tensor, _options: unknown) {
			lengths.push(ids.data.length);
			return new RawAudio(Float32Array.from(Array.from(ids.data).slice(1, -1), Number), 24000);
		},
	};
	const fake = model as unknown as Parameters<typeof generateSentenceAudio>[0];
	const audio = await generateSentenceAudio(fake, "synthetic long sentence", {});
	assert.deepEqual(lengths, [512, 512, 182]);
	assert.equal(audio.audio.length, 1200);
	assert.deepEqual([...audio.audio], Array.from({ length: 1200 }, (_, i) => i + 1));
	assert.equal(model.tokenizer, tokenizer);
	lengths.length = 0;
	await assert.rejects(generateSentenceAudio(fake, "cancelled sentence", {}, () => lengths.length > 0), /cancelled/);
	assert.deepEqual(lengths, [512], "cancellation must stop remaining internal windows");
});
