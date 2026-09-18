import { RawAudio, Tensor } from "@huggingface/transformers";

/** Keep a complete sentence as one playback/alignment unit without Kokoro's silent token truncation. */
export async function generateSentenceAudio(model, text, options, cancelled = () => false) {
	// Kokoro exposes tokenization and generate_from_ids; reuse its phonemization/normalization.
	// A per-call view avoids mutating the shared model during concurrent inference.
	const sentence = Object.create(model);
	sentence.tokenizer = (phonemes, settings) => model.tokenizer(phonemes, { ...settings, truncation: false });
	sentence.generate_from_ids = async (ids, settings) => {
		const tokens = ids.data;
		if (cancelled()) throw new Error("Speech generation cancelled");
		if (tokens.length <= 512) return model.generate_from_ids(ids, settings);
		// Kokoro cannot infer >510 phonemes at once. Stitch internal windows before exposing any audio.
		const parts = [];
		let size = 0;
		for (let start = 1; start < tokens.length - 1; start += 510) {
			if (cancelled()) throw new Error("Speech generation cancelled");
			const body = tokens.slice(start, Math.min(start + 510, tokens.length - 1));
			const input = new BigInt64Array(body.length + 2);
			input[0] = tokens[0];
			input.set(body, 1);
			input[input.length - 1] = tokens[tokens.length - 1];
			const audio = await model.generate_from_ids(new Tensor("int64", input, [1, input.length]), settings);
			parts.push(audio);
			size += audio.audio.length;
		}
		const pcm = new Float32Array(size);
		let offset = 0;
		for (const part of parts) { pcm.set(part.audio, offset); offset += part.audio.length; }
		return new RawAudio(pcm, parts[0].sampling_rate);
	};
	return model.generate.call(sentence, text, options);
}
