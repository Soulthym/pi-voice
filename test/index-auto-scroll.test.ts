import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import {
	FakeVoiceHost,
	MockedVoiceWorkerClient,
	streamCompletedResponse,
} from "./helpers/fake-voice-host.js";

const waitForScroll = async (host: FakeVoiceHost, expected: number): Promise<void> => {
	const deadline = Date.now() + 2_000;
	while (host.scrollView.scrollTop !== expected) {
		if (Date.now() > deadline) {
			assert.fail(`scrollTop did not reach ${expected}; got ${host.scrollView.scrollTop}`);
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
};

const renderedDocument = (activeLine: number, count = 300): string[] =>
	Array.from({ length: count }, (_value, line) =>
		line === activeLine ? `${NARRATION_ACTIVE_MARKER}spoken word` : `line ${line}`,
	);

test("TUI follows exact spoken words, suspends on manual scroll, and seek/resume controls re-follow", async t => {
	mock.module("../src/worker-client.js", {
		namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient },
	});

	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-auto-scroll-"));
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	await fs.writeFile(
		path.join(root, "voice.json"),
		JSON.stringify({
			enabled: true,
			mode: "assistant",
			input: "disabled",
			audioCache: false,
			autoScroll: true,
			scrollBottomShortcut: "ctrl+e",
		}),
	);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	const host = new FakeVoiceHost(path.join(root, "project"), "auto-scroll");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		mock.reset();
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	host.addMessage("user-1", null, {
		role: "user",
		content: [{ type: "text", text: "Narrate this." }],
		timestamp: 1,
	});
	await host.start();
	const text = Array.from({ length: 20 }, (_value, index) => `Sentence ${index + 1} has enough words.`).join(" ");
	await streamCompletedResponse(host, "assistant-1", "user-1", text);

	const worker = MockedVoiceWorkerClient.instances.find(instance => instance.sent.length > 0);
	assert.ok(worker, "the vocalizer worker must receive narration segments");
	const live = worker!.sent.at(-1) as { utterance: number };
	worker!.emit({ type: "idle", utterance: live.utterance } as never);

	// F11 starts replay and must force the exact marked word to 20% (8 lines)
	// from the top. This works even though the viewport began far away at line 0.
	await host.shortcut("f11");
	const replay = worker!.sent.at(-1) as { utterance: number; segmentId: number };
	host.scrollView.setDocument(renderedDocument(160), 40);
	worker!.emit({ type: "segment-audio", segmentId: replay.segmentId, start: 0, duration: 30 } as never);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 0 } as never);
	await waitForScroll(host, 152);

	// Crossing below 80% (line 184 is the edge, 185 overflows it) re-anchors
	// that individual spoken word at 20%.
	host.scrollView.setDocument(renderedDocument(185), 40);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 1 } as never);
	await waitForScroll(host, 177);

	// A manual scroll suspends follow and shows a bottom TUI hint.
	host.scrollView.manualScrollTo(20);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 2 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 20);
	const hint = host.widgets.get("pi-voice-follow-hint");
	assert.equal(hint?.placement, "belowEditor");
	assert.match(hint?.lines?.[0] ?? "", /Ctrl\+E.*follow again/);

	// The advertised shortcut follows the spoken word again (rather than merely
	// jumping to transcript end) and dismisses the hint.
	await host.shortcut("ctrl+e");
	await waitForScroll(host, 177);
	assert.equal(host.widgets.get("pi-voice-follow-hint"), undefined);

	// Timeline seek buttons route through playTarget, which must re-arm follow
	// even after another manual-scroll suspension.
	host.scrollView.manualScrollTo(10);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 3 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.ok(host.widgets.get("pi-voice-follow-hint"));
	await host.shortcut("f9");
	const sought = worker!.sent.at(-1) as { utterance: number; segmentId: number };
	host.scrollView.setDocument(renderedDocument(220), 40);
	worker!.emit({ type: "segment-audio", segmentId: sought.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 0 } as never);
	await waitForScroll(host, 212);
	assert.equal(host.widgets.get("pi-voice-follow-hint"), undefined);

	// Pause/resume is the only playback control that does not use playTarget;
	// resuming explicitly re-arms exact-word follow too.
	await host.shortcut("f8");
	host.scrollView.manualScrollTo(0);
	await host.shortcut("f8");
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 1 } as never);
	await waitForScroll(host, 212);

	// The default-on behavior is also a persisted runtime setting.
	await host.command("autoscroll off");
	host.scrollView.manualScrollTo(0);
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 2 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 0);
	await host.command("autoscroll on");
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 3 } as never);
	await waitForScroll(host, 212);
});
