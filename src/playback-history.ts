import type { NarrationSegment } from "./narration-progress.js";

export interface PlaybackMessage {
	id: string;
	text: string;
	renderKey?: string;
}

export interface PlaybackTarget extends PlaybackMessage {
	time: number;
	sourceOffset: number;
}

export interface PlaybackStatus {
	messageId: string;
	position: number;
	duration: number;
	messageIndex: number;
	messageCount: number;
	hasTimings: boolean;
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
};

type Capture = {
	record: MessageRecord;
	baseTime: number;
	recordTimings: boolean;
};

/** Keeps only text-source timing metadata; replayed audio is always regenerated. */
export class PlaybackHistory {
	#records = new Map<string, MessageRecord>();
	#order: string[] = [];
	#selectedId: string | undefined;
	#capture: Capture | undefined;
	#segments = new Map<
		number,
		{ capture: Capture; sourceOffset: number; audioStart?: number; wordOffsets: Set<number> }
	>();
	#utterances = new Map<number, Capture>();
	#activeUtterance: number | undefined;
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
				}
				existing.text = message.text;
				existing.renderKey = message.renderKey;
			} else this.#records.set(message.id, { ...message, checkpoints: [], duration: 0, position: 0 });
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
				!Array.isArray(snapshot.checkpoints) || snapshot.checkpoints.length > 2_000) continue;
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
			record.position = 0;
		}
	}

	beginCapture(id: string, text: string, baseTime = 0, recordTimings = true): void {
		let record = this.#records.get(id);
		if (!record) {
			record = { id, text, checkpoints: [], duration: 0, position: baseTime };
			this.#records.set(id, record);
		} else {
			record.text = text;
			record.position = baseTime;
		}
		if (recordTimings) {
			record.checkpoints = [];
			record.duration = 0;
		}
		this.#selectedId = id;
		this.#capture = { record, baseTime, recordTimings };
		this.#activeUtterance = undefined;
	}

	updateText(id: string, text: string): void {
		const record = this.#records.get(id);
		if (record) record.text = text;
	}

	rename(fromId: string, message: PlaybackMessage): void {
		const record = this.#records.get(fromId);
		if (!record) return;
		this.#records.delete(fromId);
		record.id = message.id;
		record.text = message.text;
		record.renderKey = message.renderKey;
		this.#records.set(message.id, record);
		if (this.#selectedId === fromId) this.#selectedId = message.id;
	}

	registerSegment(segment: NarrationSegment): void {
		const capture = this.#capture;
		if (!capture) return;
		this.#segments.set(segment.id, {
			capture,
			sourceOffset: segment.source.start,
			wordOffsets: new Set(),
		});
		this.#utterances.set(segment.utterance, capture);
		this.#activeUtterance = segment.utterance;
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
		}
	}

	setWordTimings(segmentId: number, words: Array<{ time: number; sourceOffset: number }>): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked?.capture.recordTimings || tracked.audioStart === undefined || words.length === 0) return;
		const record = tracked.capture.record;
		if (tracked.wordOffsets.size > 0) {
			record.checkpoints = record.checkpoints.filter(
				checkpoint => !tracked.wordOffsets.has(checkpoint.sourceOffset),
			);
			tracked.wordOffsets.clear();
		}
		let lastTime = Number.NEGATIVE_INFINITY;
		for (const word of words) {
			if (!Number.isFinite(word.time) || word.time < 0 || !Number.isInteger(word.sourceOffset)) continue;
			const absoluteTime = tracked.capture.baseTime + tracked.audioStart + word.time;
			if (word.sourceOffset === tracked.sourceOffset || absoluteTime - lastTime < 0.4) continue;
			record.checkpoints.push({ time: absoluteTime, duration: 0, sourceOffset: word.sourceOffset });
			tracked.wordOffsets.add(word.sourceOffset);
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
			this.#persistedUtterances.has(utterance)
		) {
			return undefined;
		}
		this.#persistedUtterances.add(utterance);
		if (!capture.record.renderKey) return undefined;
		const all = capture.record.checkpoints;
		const persisted = all.length <= 2_000
			? all
			: Array.from({ length: 2_000 }, (_value, index) =>
					all[Math.round((index * (all.length - 1)) / 1_999)] as TimingCheckpoint,
			);
		return {
			version: 3,
			messageId: capture.record.id,
			renderKey: capture.record.renderKey,
			duration: capture.record.duration,
			checkpoints: persisted.map(checkpoint => ({ ...checkpoint })),
		};
	}

	finishUtterance(utterance: number | undefined): void {
		if (utterance === undefined || utterance !== this.#activeUtterance) return;
		const capture = this.#utterances.get(utterance);
		if (!capture || capture.record.duration <= 0) return;
		capture.record.position = capture.record.duration;
	}

	setPlayback(utterance: number, position: number): void {
		const capture = this.#utterances.get(utterance);
		if (!capture || utterance !== this.#activeUtterance || !Number.isFinite(position)) return;
		capture.record.position = Math.max(0, capture.baseTime + position);
	}

	selected(): PlaybackMessage | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return record ? { id: record.id, text: record.text } : undefined;
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

	resumeTarget(): PlaybackTarget | undefined {
		return this.seekTarget(0) ?? this.restartTarget();
	}

	hasTimingFor(messageId: string): boolean {
		return Boolean(this.#records.get(messageId)?.checkpoints.length);
	}

	hasTimings(): boolean {
		return this.#selectedId ? this.hasTimingFor(this.#selectedId) : false;
	}
}
