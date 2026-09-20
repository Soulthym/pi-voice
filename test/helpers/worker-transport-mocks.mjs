// Real worker/helper transport; synthesis and alignment never load models.
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import * as children from "node:child_process";
mock.module("@huggingface/transformers", { namedExports: {
	env: {}, RawAudio: class {}, Tensor: class {}, pipeline: () => { throw Error("No inference allowed"); },
} });
mock.module("kokoro-js", { namedExports: { KokoroTTS: {} } });
mock.module("node:child_process", { namedExports: { ...children,
	fork: () => {
		const child = Object.assign(new EventEmitter(), {
			send: ({ id }) => queueMicrotask(() => child.emit("message", {
				id, audio: { pcm: Float32Array.of(0.5), sampleRate: 24000 },
			})),
			kill: () => {},
		});
		return child;
	},
	spawn: (command, args, options) => {
		if (!args[0].endsWith("/tcp-playback.mjs")) throw Error("No alignment allowed");
		return children.spawn(command, args, options);
	},
} });
