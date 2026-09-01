import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import {
	FakeVoiceHost,
	MockedVoiceWorkerClient,
	assistant,
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
			scrollToShortcut: "alt+v",
			scrollBottomShortcut: "alt+t",
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
	const liveSegments = worker!.sent as Array<{ utterance: number; segmentId: number }>;
	const liveUtterance = liveSegments.at(-1)!.utterance;
	const contentSegments = liveSegments.filter(segment => segment.utterance === liveUtterance);
	const live = contentSegments[0]!;
	host.scrollView.setDocument(renderedDocument(160), 40);
	contentSegments.forEach((segment, index) => {
		worker!.emit({ type: "segment-audio", segmentId: segment.segmentId, start: index * 2, duration: 2 } as never);
	});
	worker!.emit({ type: "playback", utterance: live.utterance, position: 0 } as never);
	await waitForScroll(host, 152);
	worker!.emit({ type: "idle", utterance: live.utterance } as never);
	assert.equal(host.scrollView.scrollTop, 260, "automatic live narration should restore prior bottom-follow");
	assert.equal(host.scrollView.isFollowingEnd, true);

	// F11 starts replay and must place an out-of-frame marked word at 20%.
	// Register every sentence as a separate 2-second checkpoint so F7/F9 below
	// exercise genuine timeline movement rather than restarting checkpoint zero.
	const replayStart = worker!.sent.length;
	host.scrollView.setDocument(renderedDocument(160), 40);
	host.scrollView.manualScrollTo(0);
	await host.shortcut("f11");
	assert.equal(host.scrollView.scrollTop, 152, "message replay should anchor before its first audio event");
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
	host.scrollView.piVoiceCacheNarrationLayout = true;
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 0 } as never);
	await waitForScroll(host, 152);
	await new Promise(resolve => setTimeout(resolve, 120));
	const transcriptRenders = host.scrollView.renderCalls;
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 0.05 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(
		host.scrollView.renderCalls,
		transcriptRenders,
		"repeated playback ticks within one word must not rerender the full transcript",
	);
	host.scrollView.piVoiceCacheNarrationLayout = false;

	// Crossing below 80% (line 184 is the edge, 185 overflows it) re-anchors
	// that individual spoken word at 20%.
	host.scrollView.setDocument(renderedDocument(185), 40);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 1 } as never);
	await waitForScroll(host, 177);

	// Manual framing is accepted while the spoken word remains within 20–80%.
	// Tracking stays armed, and a TUI hint offers immediate re-anchoring.
	host.scrollView.manualScrollTo(160);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 2 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 160);
	const hint = host.widgets.get("pi-voice-follow-hint");
	assert.equal(hint?.placement, "belowEditor");
	assert.match(hint?.lines?.[0] ?? "", /Alt\+V.*re-anchor spoken text/);

	// /voice scroll-to and its advertised shortcut re-anchor the narrated word.
	await host.command("scroll-to");
	await waitForScroll(host, 177);
	assert.equal(host.widgets.get("pi-voice-follow-hint"), undefined);

	// /voice bottom is distinct: it pins transcript-end following and subsequent
	// word updates cannot pull it back to the narrated position.
	await host.command("bottom");
	assert.equal(host.scrollView.scrollTop, 260);
	worker!.emit({ type: "playback", utterance: replay.utterance, position: 2.25 } as never);
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 260);
	await host.shortcut("alt+v");
	await waitForScroll(host, 177);
	await host.shortcut("alt+t");
	assert.equal(host.scrollView.scrollTop, 260);
	await host.command("scroll-to");
	await waitForScroll(host, 177);

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
	const forwardSentence = Number(/Sentence (\d+)/.exec(forwardSegments.map(segment => segment.text).join(" "))?.[1]);
	assert.ok(forwardSentence > 1, `F9 did not advance: ${forwardSegments.map(segment => segment.text).join(" ")}`);
	host.scrollView.setDocument(renderedDocument(180), 40); // 20/40 lines down: already in-band
	worker!.emit({ type: "segment-audio", segmentId: forward.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: forward.utterance, position: 0 } as never);
	assert.ok(host.render(text).includes(NARRATION_ACTIVE_MARKER));
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 160);

	// F7 immediately previews and anchors its target before audio starts. Once
	// manually reframed in-band, the first playback tick preserves that framing.
	host.scrollView.setDocument(renderedDocument(220), 40);
	const backwardStart = worker!.sent.length;
	await host.shortcut("f7");
	assert.equal(host.scrollView.scrollTop, 212);
	host.scrollView.manualScrollTo(160);
	host.scrollView.setDocument(renderedDocument(180), 40);
	const backwardSegments = worker!.sent.slice(backwardStart) as Array<{
		utterance: number;
		segmentId: number;
		text: string;
	}>;
	const sought = backwardSegments[0]!;
	assert.ok(sought, "F7 must regenerate from an earlier checkpoint");
	const backwardSentence = Number(/Sentence (\d+)/.exec(backwardSegments.map(segment => segment.text).join(" "))?.[1]);
	assert.ok(backwardSentence < forwardSentence, `${backwardSentence} should precede ${forwardSentence}`);
	worker!.emit({ type: "segment-audio", segmentId: sought.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 0 } as never);
	assert.ok(host.render(text).includes(NARRATION_ACTIVE_MARKER));
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(host.scrollView.scrollTop, 160);
	assert.ok(host.widgets.get("pi-voice-follow-hint"));

	// The next word crossing 80% still snaps normally.
	host.scrollView.setDocument(renderedDocument(193), 40); // 33/40 lines down
	worker!.emit({ type: "playback", utterance: sought.utterance, position: 1 } as never);
	await waitForScroll(host, 185);

	// Pausing must preserve the exact viewport even when pause-related widget
	// updates would otherwise make Pi's follow-end layout snap to the bottom.
	host.snapScrollOnWidgetUpdate = true;
	await host.shortcut("f8");
	host.snapScrollOnWidgetUpdate = false;
	assert.equal(host.scrollView.scrollTop, 185);

	// Seeking directly from an F8-paused transport must explicitly clear worker
	// pause state before regenerated audio is queued.
	assert.equal(worker!.pauses.at(-1), true);
	await fs.stat(path.join(root, "coordinator", "speech.lock", "lease.json"));
	const pausedSeekStart = worker!.sent.length;
	await host.shortcut("f9");
	assert.equal(worker!.pauses.at(-1), true, "timeline movement must retain paused transport state");
	const pausedSeekSegments = worker!.sent.slice(pausedSeekStart) as Array<{
		utterance: number;
		segmentId: number;
		text: string;
	}>;
	const pausedSeek = pausedSeekSegments[0]!;
	assert.ok(pausedSeek, "F9 after pause must queue fresh playback");
	assert.match(host.render(text), new RegExp(`${NARRATION_ACTIVE_MARKER}Sentence`));
	assert.equal(host.scrollView.scrollTop, 185);

	// Resume keeps the current framing. Pausing it again preserves a manually
	// framed viewport, and the next resume re-arms normal 20–80 tracking.
	await host.shortcut("f8");
	assert.equal(worker!.pauses.at(-1), false);
	worker!.emit({ type: "segment-audio", segmentId: pausedSeek.segmentId, start: 0, duration: 20 } as never);
	worker!.emit({ type: "playback", utterance: pausedSeek.utterance, position: 0 } as never);
	assert.equal(host.scrollView.scrollTop, 185);
	host.scrollView.manualScrollTo(180); // active line 193 is safely in-band
	await host.shortcut("f8");
	assert.equal(host.scrollView.scrollTop, 180);
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

	// Stop invalidates a paused transport; a later F8 cannot "resume" a ghost
	// sink or reacquire the device indefinitely.
	await host.shortcut("f8");
	await host.command("stop");
	const pauseCommandsAfterStop = worker!.pauses.length;
	await host.shortcut("f8");
	assert.equal(worker!.pauses.length, pauseCommandsAfterStop);
	assert.ok(host.notices.some(notice => notice.message.includes("no assistant message playing")));

	// Message movement also previews and anchors while paused without starting
	// the replacement sink. Moving back in-band preserves the chosen framing.
	host.addMessage("user-2", "assistant-1", {
		role: "user",
		content: [{ type: "text", text: "Another response." }],
		timestamp: 2,
	});
	host.addMessage("assistant-2", "user-2", assistant("Second historical response."));
	await host.emit("agent_settled", { type: "agent_settled" });
	host.scrollView.setDocument(renderedDocument(240), 40);
	await host.shortcut("f11");
	await host.shortcut("f8");
	assert.equal(worker!.pauses.at(-1), true);
	// Pi's Markdown component still has the previous message's marker cached when
	// the key handler starts. The move must invalidate that cache before scanning.
	host.scrollView.queueDocument(renderedDocument(80), 40);
	await host.shortcut("f6");
	assert.equal(host.scrollView.scrollTop, 72);
	assert.equal(worker!.pauses.at(-1), true);
	assert.ok(host.render(text).includes(NARRATION_ACTIVE_MARKER));
	host.scrollView.manualScrollTo(90);
	host.scrollView.queueDocument(renderedDocument(100), 40);
	const latestStart = worker!.sent.length;
	await host.shortcut("f10");
	assert.equal(host.scrollView.scrollTop, 90);
	assert.equal(worker!.pauses.at(-1), true);
	const latestSegments = worker!.sent.slice(latestStart) as Array<{
		utterance: number;
		segmentId: number;
	}>;
	assert.ok(latestSegments.length > 0);
	latestSegments.forEach((segment, index) => {
		worker!.emit({ type: "segment-audio", segmentId: segment.segmentId, start: index * 2, duration: 2 } as never);
	});
	const latestUtterance = latestSegments.at(-1)!.utterance;
	worker!.emit({
		type: "playback",
		utterance: latestUtterance,
		position: 1_000, // clamps to the completed message duration
	} as never);

	// Transcript-tail follow is the sentinel after the latest message. F10 from
	// that message and F9 after its final checkpoint both behave like Alt+T,
	// without restarting playback or changing its paused state.
	const tailStart = worker!.sent.length;
	host.scrollView.manualScrollTo(90);
	await host.shortcut("f10");
	assert.equal(host.scrollView.scrollTop, 260);
	assert.equal(host.scrollView.isFollowingEnd, true);
	assert.equal(worker!.sent.length, tailStart);
	host.scrollView.manualScrollTo(90);
	await host.shortcut("f9");
	assert.equal(host.scrollView.scrollTop, 260);
	assert.equal(host.scrollView.isFollowingEnd, true);
	assert.equal(worker!.sent.length, tailStart);
	assert.equal(worker!.pauses.at(-1), true);
	await host.command("stop");

	// User-triggered replay must leave the resulting historical viewport in place
	// when it finishes instead of restoring transcript-end following.
	host.scrollView.setDocument(renderedDocument(80), 40);
	host.scrollView.manualScrollTo(200);
	const manualReplayStart = worker!.sent.length;
	await host.shortcut("f11");
	assert.equal(host.scrollView.scrollTop, 72);
	const manualReplay = (worker!.sent.slice(manualReplayStart) as Array<{ utterance: number }>).at(-1)!;
	worker!.emit({ type: "idle", utterance: manualReplay.utterance } as never);
	assert.equal(host.scrollView.scrollTop, 72);
	assert.equal(host.scrollView.isFollowingEnd, false);

	// Manual replay during a newly streaming turn must never append later live
	// deltas to the historical replay transport.
	worker!.emit({ type: "idle", utterance: pausedSeek.utterance } as never);
	const partial = assistant("Live prefix. Queued while paused. Live tail must stay separate.", "pending");
	await host.emit("before_agent_start", { type: "before_agent_start" });
	await host.emit("message_start", { type: "message_start", message: partial });
	await host.emit("message_update", {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Live prefix. ", partial },
	});
	const beforeLivePause = worker!.sent.length;
	await host.shortcut("f8");
	await fs.stat(path.join(root, "coordinator", "speech.lock", "lease.json"));
	await host.emit("message_update", {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Queued while paused. ", partial },
	});
	await new Promise(resolve => setTimeout(resolve, 1_100)); // Vocalizer idle flush
	assert.ok(worker!.sent.length > beforeLivePause, "live deltas must remain queued behind F8 pause");
	await host.shortcut("f8");
	await host.shortcut("f6");
	const afterReplayStarted = worker!.sent.length;
	await host.emit("message_update", {
		type: "message_update",
		message: partial,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "Live tail must stay separate.",
			partial,
		},
	});
	assert.equal(worker!.sent.length, afterReplayStarted, "live tail leaked into historical replay audio");
	assert.equal(
		worker!.sent.slice(afterReplayStarted).some(item => String((item as { text?: string }).text).includes("Live tail")),
		false,
	);
});
