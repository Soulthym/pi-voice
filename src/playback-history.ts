import { SpeakableStream } from "./speakable.js";
import type { NarrationSegment } from "./narration-progress.js";

export interface PlaybackMessage {
	id: string;
	text: string;
	renderKey?: string;
	messageType?: "assistant" | "assistant-thinking";
	contentIndex?: number;
	displayOffset?: number;
}

export interface PlaybackUnit {
	sourceOffset: number;
	skipUnits: number;
}

export interface PlaybackTarget extends PlaybackMessage {
	time: number;
	sourceOffset: number;
	skipUnits?: number;
}

export interface PlaybackStatus {
	messageId: string;
	position: number;
	duration: number;
	messageIndex: number;
	messageCount: number;
	hasTimings: boolean;
	timingsComplete: boolean;
}

export interface PlaybackTimingSnapshot {
	version: 3;
	messageId: string;
	renderKey: string;
	duration: number;
	checkpoints: Array<{ time: number; duration: number; sourceOffset: number }>;
}

type TimingCheckpoint = {
	time: number;
	duration: number;
	sourceOffset: number;
};

type MessageRecord = PlaybackMessage & {
	checkpoints: TimingCheckpoint[];
	duration: number;
	position: number;
	timingsComplete: boolean;
	cursor?: PlaybackUnit;
};

type Capture = {
	epoch: number;
	record: MessageRecord;
	baseTime: number;
	recordTimings: boolean;
	origin: PlaybackUnit;
	segments: CapturedSegment[];
};

type CapturedSegment = {
	capture: Capture; utterance: number; sourceOffset: number; skipUnits: number;
	audioStart?: number; wordOffsets: Set<number>; sourceBase: number; code: boolean;
};

/** Keeps only text-source timing metadata; replayed audio is always regenerated. */
export class PlaybackHistory {
	#records = new Map<string, MessageRecord>();
	#order: string[] = [];
	#selectedId: string | undefined;
	#capture: Capture | undefined;
	#segments = new Map<number, CapturedSegment>();
	#utterances = new Map<number, Capture>();
	#endedUtterances = new Set<number>();
	#finishedUtterances = new Set<number>();
	#activeUtterance: number | undefined;
	#playbackEpoch = 0;
	#persistedUtterances = new Set<number>();

	sync(messages: PlaybackMessage[], selectLatest = false): void {
		this.#order = messages.map(message => message.id);
		for (const message of messages) {
			const existing = this.#records.get(message.id);
			if (existing) {
				if (existing.text !== message.text || existing.renderKey !== message.renderKey) {
					existing.checkpoints = [];
					existing.duration = 0;
					existing.position = 0;
					if (existing.text !== message.text) existing.cursor = undefined;
					existing.timingsComplete = false;
				}
				existing.messageType = message.messageType;
				existing.contentIndex = message.contentIndex;
				existing.displayOffset = message.displayOffset;
				existing.text = message.text;
				existing.renderKey = message.renderKey;
			} else this.#records.set(message.id, { ...message, checkpoints: [], duration: 0, position: 0, timingsComplete: false });
		}
		if (selectLatest || !this.#selectedId || !this.#order.includes(this.#selectedId)) {
			this.#selectedId = this.#order.at(-1);
		}
	}

	restore(snapshots: readonly PlaybackTimingSnapshot[]): void {
		for (const snapshot of snapshots) {
			if (snapshot.version !== 3 || !Number.isFinite(snapshot.duration) || snapshot.duration < 0) continue;
			const record = this.#records.get(snapshot.messageId);
			if (
				!record ||
				!record.renderKey ||
				snapshot.renderKey !== record.renderKey ||
				!Array.isArray(snapshot.checkpoints) || snapshot.checkpoints.length > 100_000) continue;
			const checkpoints = snapshot.checkpoints.filter(
				checkpoint =>
					Number.isFinite(checkpoint.time) &&
					checkpoint.time >= 0 &&
					Number.isFinite(checkpoint.duration) &&
					checkpoint.duration >= 0 &&
					Number.isInteger(checkpoint.sourceOffset) &&
					checkpoint.sourceOffset >= 0 &&
					checkpoint.sourceOffset < record.text.length,
			);
			if (checkpoints.length === 0) continue;
			record.checkpoints = checkpoints.map(checkpoint => ({ ...checkpoint })).sort((left, right) => left.time - right.time);
			record.duration = snapshot.duration;
			record.timingsComplete = true;
		}
	}

	beginCapture(id: string, text: string, baseTime = 0, recordTimings = true, sourceOffset = 0, skipUnits = 0, select = true): void {
		let record = this.#records.get(id);
		if (!record) {
			record = { id, text, checkpoints: [], duration: 0, position: baseTime, timingsComplete: false };
			this.#records.set(id, record);
		} else {
			record.text = text;
			record.position = baseTime;
		}
		if (recordTimings) {
			record.checkpoints = [];
			record.duration = 0;
			record.timingsComplete = false;
		}
		// Replay selects immediately and fences ticks from the displaced transport.
		// Queued live captures must leave the audible selection and its ticks alone.
		if (select) {
			this.#selectedId = id;
			this.#playbackEpoch++;
			this.#activeUtterance = undefined;
		}
		record.cursor = { sourceOffset, skipUnits };
		this.#capture = { epoch: this.#playbackEpoch, record, baseTime, recordTimings, origin: record.cursor, segments: [] };
	}

	updateText(id: string, text: string, source?: Pick<PlaybackMessage, "messageType" | "contentIndex" | "displayOffset">): void {
		const record = this.#records.get(id);
		if (!record) return;
		record.text = text;
		if (source) {
			record.messageType = source.messageType;
			record.contentIndex = source.contentIndex;
			record.displayOffset = source.displayOffset;
		}
	}

	rename(fromId: string, message: PlaybackMessage): void {
		const record = this.#records.get(fromId);
		if (!record) return;
		this.#records.delete(fromId);
		record.messageType = message.messageType;
		record.contentIndex = message.contentIndex;
		record.displayOffset = message.displayOffset;
		record.id = message.id;
		record.text = message.text;
		record.renderKey = message.renderKey;
		this.#records.set(message.id, record);
		if (this.#selectedId === fromId) this.#selectedId = message.id;
	}

	/** Bind before async descriptions resolve and another target becomes current. */
	bindUtterance(utterance: number): void {
		if (this.#capture) this.#utterances.set(utterance, this.#capture);
	}

	registerSegment(segment: NarrationSegment): void {
		const capture = this.#utterances.get(segment.utterance) ?? this.#capture;
		if (!capture) return;
		// The extension registers suffix-relative ranges; navigation uses whole-message ranges.
		const sourceOffset = segment.source.start + capture.origin.sourceOffset;
		const previous = capture.segments.at(-1);
		const skipUnits = previous?.sourceOffset === sourceOffset ? previous.skipUnits + 1
			: capture.origin.sourceOffset === sourceOffset ? capture.origin.skipUnits : 0;
		const tracked: CapturedSegment = {
			capture, utterance: segment.utterance, sourceOffset, skipUnits, wordOffsets: new Set(),
			sourceBase: segment.sourceBase ?? 0, code: Boolean(segment.code || segment.codeDescription),
		};
		this.#segments.set(segment.id, tracked);
		capture.segments.push(tracked);
		this.#utterances.set(segment.utterance, capture);
	}

	setSegmentAudio(segmentId: number, start: number, duration: number): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked || !Number.isFinite(start) || !Number.isFinite(duration)) return;
		const normalizedStart = Math.max(0, start);
		tracked.audioStart = normalizedStart;
		const absoluteTime = tracked.capture.baseTime + normalizedStart;
		const record = tracked.capture.record;
		if (tracked.capture.recordTimings) {
			record.checkpoints.push({
				time: absoluteTime,
				duration: Math.max(0, duration),
				sourceOffset: tracked.sourceOffset,
			});
			record.checkpoints.sort((left, right) => left.time - right.time);
			record.duration = Math.max(record.duration, absoluteTime + Math.max(0, duration));
			this.#completeTimingsIfReady(tracked.utterance);
		}
	}

	setWordTimings(segmentId: number, words: Array<{ time: number; sourceOffset: number }>): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked?.capture.recordTimings || tracked.code || tracked.audioStart === undefined || words.length === 0) return;
		const record = tracked.capture.record;
		if (tracked.wordOffsets.size > 0) {
			record.checkpoints = record.checkpoints.filter(
				checkpoint => checkpoint.duration > 0 || !tracked.wordOffsets.has(checkpoint.sourceOffset),
			);
			tracked.wordOffsets.clear();
		}
		let lastTime = Number.NEGATIVE_INFINITY;
		for (const word of words) {
			if (!Number.isFinite(word.time) || word.time < 0 || !Number.isInteger(word.sourceOffset)) continue;
			const absoluteTime = tracked.capture.baseTime + tracked.audioStart + word.time;
			const sourceOffset = word.sourceOffset - tracked.sourceBase + tracked.capture.origin.sourceOffset;
			if (sourceOffset < 0 || sourceOffset === tracked.sourceOffset || absoluteTime - lastTime < 0.4) continue;
			record.checkpoints.push({ time: absoluteTime, duration: 0, sourceOffset });
			tracked.wordOffsets.add(sourceOffset);
			lastTime = absoluteTime;
		}
		record.checkpoints.sort((left, right) => left.time - right.time);
	}

	snapshotForUtterance(utterance: number): PlaybackTimingSnapshot | undefined {
		const capture = this.#utterances.get(utterance);
		if (
			!capture?.recordTimings ||
			capture.record.id.startsWith("live:") ||
			capture.record.checkpoints.length === 0 ||
			!capture.record.timingsComplete ||
			this.#persistedUtterances.has(utterance)
		) {
			return undefined;
		}
		this.#persistedUtterances.add(utterance);
		if (!capture.record.renderKey) return undefined;
		// Keep sentence boundaries intact; word checkpoints are already rate-limited.
		const persisted = capture.record.checkpoints;
		return {
			version: 3,
			messageId: capture.record.id,
			renderKey: capture.record.renderKey,
			duration: capture.record.duration,
			checkpoints: persisted.map(checkpoint => ({ ...checkpoint })),
		};
	}

	finishTimingGeneration(utterance: number): void {
		this.#endedUtterances.add(utterance);
		this.#completeTimingsIfReady(utterance);
	}

	finishUtterance(utterance: number | undefined): void {
		if (utterance === undefined) return;
		this.#finishedUtterances.add(utterance);
		this.#endedUtterances.add(utterance);
		this.#completeTimingsIfReady(utterance);
		const capture = this.#utterances.get(utterance);
		if (!capture || capture.epoch !== this.#playbackEpoch ||
			(this.#activeUtterance !== undefined && utterance !== this.#activeUtterance)) return;
		const last = capture.segments.at(-1);
		if (last) capture.record.cursor = { sourceOffset: last.sourceOffset, skipUnits: last.skipUnits };
		if (capture.record.timingsComplete) capture.record.position = capture.record.duration;
	}

	#completeTimingsIfReady(utterance: number): void {
		if (!this.#endedUtterances.has(utterance)) return;
		const capture = this.#utterances.get(utterance);
		if (!capture?.recordTimings) return;
		const segments = [...this.#segments.values()].filter(
			tracked => tracked.capture === capture && tracked.utterance === utterance,
		);
		if (segments.length > 0 && segments.every(segment => segment.audioStart !== undefined)) {
			capture.record.timingsComplete = true;
		}
	}

	setPlayback(utterance: number, position: number): void {
		const capture = this.#utterances.get(utterance);
		if (!capture || capture.epoch !== this.#playbackEpoch || this.#finishedUtterances.has(utterance) || !Number.isFinite(position) ||
			(this.#activeUtterance !== undefined && utterance < this.#activeUtterance)) return;
		// Utterance ids follow playback order, not asynchronous registration order.
		this.#activeUtterance = utterance;
		this.#selectedId = capture.record.id;
		capture.record.position = Math.max(0, capture.baseTime + position);
		const segment = capture.segments.findLast(segment => segment.audioStart !== undefined && segment.audioStart <= position);
		if (segment) capture.record.cursor = { sourceOffset: segment.sourceOffset, skipUnits: segment.skipUnits };
	}

	selected(): PlaybackMessage | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return record ? { id: record.id, text: record.text, ...(record.messageType ? { messageType: record.messageType, contentIndex: record.contentIndex, displayOffset: record.displayOffset } : {}) } : undefined;
	}

	status(): PlaybackStatus | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		if (!record) return undefined;
		const index = this.#order.indexOf(record.id);
		return {
			messageId: record.id,
			position: Math.max(0, Math.min(record.duration || record.position, record.position)),
			duration: record.duration,
			messageIndex: index,
			messageCount: this.#order.length,
			hasTimings: record.checkpoints.length > 0,
			timingsComplete: record.timingsComplete,
		};
	}

	move(delta: -1 | 1): PlaybackMessage | undefined {
		if (this.#order.length === 0) return undefined;
		const current = this.#selectedId ? this.#order.indexOf(this.#selectedId) : -1;
		const index = current < 0 ? this.#order.length - 1 : Math.max(0, Math.min(this.#order.length - 1, current + delta));
		this.#selectedId = this.#order[index];
		return this.selected();
	}

	restartTarget(): PlaybackTarget | undefined {
		const message = this.selected();
		return message ? { ...message, time: 0, sourceOffset: 0 } : undefined;
	}

	seekTarget(deltaSeconds: number): PlaybackTarget | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		if (!record || record.checkpoints.length === 0) return undefined;
		const desired = Math.max(0, Math.min(record.duration, record.position + deltaSeconds));
		let closest = record.checkpoints[0];
		for (const checkpoint of record.checkpoints) {
			if (Math.abs(checkpoint.time - desired) < Math.abs(closest.time - desired)) closest = checkpoint;
		}
		// Sparse checkpoints can tie around the requested offset. A directional
		// scrub must still advance rather than selecting its current checkpoint.
		if (deltaSeconds > 0 && closest.time <= record.position) {
			closest = record.checkpoints.find(checkpoint => checkpoint.time > record.position) ?? closest;
		} else if (deltaSeconds < 0 && closest.time >= record.position) {
			closest = record.checkpoints.findLast(checkpoint => checkpoint.time < record.position) ?? closest;
		}
		return { id: record.id, text: record.text, time: closest.time, sourceOffset: closest.sourceOffset };
	}

	canSeekForward(): boolean {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return Boolean(record?.checkpoints.some(checkpoint => checkpoint.time > record.position));
	}

	/** Whole source units work before timing exists; code descriptions supply per-block ordinals. */
	sentenceTarget(direction: -1 | 1, units?: PlaybackUnit[], fromTail = false): PlaybackTarget | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		if (!record) return undefined;
		if (!units) {
			const stream = new SpeakableStream();
			units = [...stream.push(record.text), ...stream.flush()].map(item => ({ sourceOffset: item.source.start, skipUnits: 0 }));
		}
		if (!units.length) return undefined;
		const cursor = record.cursor ?? { sourceOffset: 0, skipUnits: 0 };
		let current = units.findLastIndex(unit => unit.sourceOffset < cursor.sourceOffset ||
			(unit.sourceOffset === cursor.sourceOffset && unit.skipUnits <= cursor.skipUnits));
		current = Math.max(0, current);
		const next = fromTail && direction < 0 ? units.length - 1 : Math.max(0, current + direction);
		if (next >= units.length) return undefined;
		return this.#unitTarget(record, units[next]);
	}

	#unitTarget(record: MessageRecord, unit: PlaybackUnit): PlaybackTarget {
		const checkpoint = record.checkpoints.filter(point => point.duration > 0 && point.sourceOffset === unit.sourceOffset)[unit.skipUnits];
		const time = checkpoint?.time ?? 0;
		record.cursor = unit;
		record.position = time;
		return { ...this.selected()!, time, sourceOffset: unit.sourceOffset, skipUnits: unit.skipUnits };
	}

	resumeTarget(): PlaybackTarget | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return record?.cursor ? this.#unitTarget(record, record.cursor) : this.restartTarget();
	}

	hasTimingFor(messageId: string): boolean {
		return Boolean(this.#records.get(messageId)?.checkpoints.length);
	}

	hasCompleteTimingFor(messageId: string): boolean {
		const record = this.#records.get(messageId);
		return Boolean(record?.timingsComplete && record.checkpoints.length > 0);
	}

	hasTimings(): boolean {
		return this.#selectedId ? this.hasTimingFor(this.#selectedId) : false;
	}
}
