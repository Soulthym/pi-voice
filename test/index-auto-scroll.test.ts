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

test("TUI follows exact words, permits in-band framing, and seek/resume controls re-follow", async t => {
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

	// F11 starts replay and must place an out-of-frame marked word at 20%.
	// Register every sentence as a separate 2-second checkpoint so F7/F9 below
	// exercise genuine timeline movement rather than restarting checkpoint zero.
	const replayStart = worker!.sent.length;
	await host.shortcut("f11");
	const replaySegments = worker!.sent.slice(replayStart) as Array<{
		utterance: number;
		segmentId: number;
		text: string;
	}>;
	assert.ok(replaySegments.length >= 10, "the fixture must produce a multi-checkpoint timeline");
	const replay = replaySegments[0]!;
	replaySegments.forEach((segment, index) => {
		worker!.emit({ type: "segment-audio", segmentId: segment.segmentId, start: index * 2, duration: 2 } as never);
	});
	host.scrollView.setDocument(renderedDocument(160), 40);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 0 } as never);
	await waitForScroll(host, 152);

	// Crossing below 80% (line 184 is the edge, 185 overflows it) re-anchors
	// that individual spoken word at 20%.
	host.scrollView.setDocument(renderedDocument(185), 40);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 1 } as never);
	await waitForScroll(host, 177);

	// Manual framing is accepted while the spoken word remains within 20–80%.
	// Tracking stays armed, and a bottom TUI hint offers immediate re-anchoring.
	host.scrollView.manualScrollTo(160);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 2 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 160);
	const hint = host.widgets.get("pi-voice-follow-hint");
	assert.equal(hint?.placement, "belowEditor");
	assert.match(hint?.lines?.[0] ?? "", /Ctrl\+E.*re-anchor spoken text/);

	// The advertised shortcut restores the canonical 20% anchor immediately
	// (rather than merely jumping to transcript end) and dismisses the hint.
	await host.shortcut("ctrl+e");
	await waitForScroll(host, 177);
	assert.equal(host.widgets.get("pi-voice-follow-hint"), undefined);

	// Moving just beyond the 80% edge is the point at which auto-scroll snaps.
	host.scrollView.manualScrollTo(152); // active line 185 is now 33/40 lines down
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 2.5 } as never);
	await waitForScroll(host, 177);
	assert.equal(host.widgets.get("pi-voice-follow-hint"), undefined);

	// Timeline seek buttons route through playTarget, but re-arming is not a
	// forced snap: a sought word already inside 20–80% keeps current framing.
	host.scrollView.manualScrollTo(160);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 3 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.ok(host.widgets.get("pi-voice-follow-hint"));
	const forwardStart = worker!.sent.length;
	await host.shortcut("f9");
	const forwardSegments = worker!.sent.slice(forwardStart) as Array<{
		utterance: number;
		segmentId: number;
		text: string;
	}>;
	const forward = forwardSegments[0]!;
	assert.ok(forward, "F9 must regenerate from a later checkpoint");
	const forwardSentence = Number(/Sentence (\d+)/.exec(forward.text)?.[1]);
	assert.ok(forwardSentence > 1, `F9 did not advance: ${forward.text}`);
	host.scrollView.setDocument(renderedDocument(180), 40); // 20/40 lines down: already in-band
	worker!.emit({ type: "segment-audio", segmentId: forward.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: forward.utterance, position: 0 } as never);
	assert.match(host.render(text), new RegExp(`${NARRATION_ACTIVE_MARKER}Sentence ${forwardSentence}`));
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 160);

	// F7 from that new base time must move to an earlier persisted checkpoint,
	// retain usable playback state, and preserve an in-band viewport too.
	const backwardStart = worker!.sent.length;
	await host.shortcut("f7");
	const backwardSegments = worker!.sent.slice(backwardStart) as Array<{
		utterance: number;
		segmentId: number;
		text: string;
	}>;
	const sought = backwardSegments[0]!;
	assert.ok(sought, "F7 must regenerate from an earlier checkpoint");
	const backwardSentence = Number(/Sentence (\d+)/.exec(sought.text)?.[1]);
	assert.ok(backwardSentence < forwardSentence, `${backwardSentence} should precede ${forwardSentence}`);
	worker!.emit({ type: "segment-audio", segmentId: sought.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 0 } as never);
	assert.match(host.render(text), new RegExp(`${NARRATION_ACTIVE_MARKER}Sentence ${backwardSentence}`));
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 160);
	assert.equal(host.widgets.get("pi-voice-follow-hint"), undefined);

	// The next word crossing 80% still snaps normally.
	host.scrollView.setDocument(renderedDocument(193), 40); // 33/40 lines down
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 1 } as never);
	await waitForScroll(host, 185);

	// Seeking directly from an F8-paused transport must explicitly clear worker
	// pause state before regenerated audio is queued.
	await host.shortcut("f8");
	assert.equal(host.scrollView.scrollTop, 185);
	assert.equal(worker!.pauses.at(-1), true);
	const pausedSeekStart = worker!.sent.length;
	await host.shortcut("f9");
	assert.equal(worker!.pauses.at(-1), false);
	const pausedSeekSegments = worker!.sent.slice(pausedSeekStart) as Array<{
		utterance: number;
		segmentId: number;
		text: string;
	}>;
	const pausedSeek = pausedSeekSegments[0]!;
	assert.ok(pausedSeek, "F9 after pause must queue fresh playback");
	worker!.emit({ type: "segment-audio", segmentId: pausedSeek.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: pausedSeek.utterance, position: 0 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 185);

	// F8 pause preserves the current viewport rather than restoring transcript
	// bottom; resume then has the same non-forcing semantics as seek controls.
	await host.shortcut("f8");
	assert.equal(host.scrollView.scrollTop, 185);
	host.scrollView.manualScrollTo(180); // active line 193 is safely in-band
	await host.shortcut("f8");
	worker!.emit({ type: "playback", utterance: pausedSeek.utterance, position: 1.5 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 180);
	host.scrollView.setDocument(renderedDocument(213), 40); // now 33/40 lines down
	worker!.emit({ type: "playback", utterance: pausedSeek.utterance, position: 2 } as never);
	await waitForScroll(host, 205);

	// The default-on behavior is also a persisted runtime setting.
	await host.command("autoscroll off");
	host.scrollView.manualScrollTo(0);
	worker!.emit({ type: "playback", utterance: pausedSeek.utterance, position: 2.5 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 0);
	await host.command("autoscroll on");
	worker!.emit({ type: "playback", utterance: pausedSeek.utterance, position: 3 } as never);
	await waitForScroll(host, 205);
});
