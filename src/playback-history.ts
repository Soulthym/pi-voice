import type { NarrationSegment } from "./narration-progress.js";

export interface PlaybackMessage {
	id: string;
	text: string;
}

export interface PlaybackTarget extends PlaybackMessage {
	time: number;
	sourceOffset: number;
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
	#segments = new Map<number, { capture: Capture; sourceOffset: number }>();
	#utterances = new Map<number, Capture>();
	#activeUtterance: number | undefined;

	sync(messages: PlaybackMessage[], selectLatest = false): void {
		this.#order = messages.map(message => message.id);
		for (const message of messages) {
			const existing = this.#records.get(message.id);
			if (existing) existing.text = message.text;
			else this.#records.set(message.id, { ...message, checkpoints: [], duration: 0, position: 0 });
		}
		if (selectLatest || !this.#selectedId || !this.#order.includes(this.#selectedId)) {
			this.#selectedId = this.#order.at(-1);
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

	rename(fromId: string, message: PlaybackMessage): void {
		const record = this.#records.get(fromId);
		if (!record) return;
		this.#records.delete(fromId);
		record.id = message.id;
		record.text = message.text;
		this.#records.set(message.id, record);
		if (this.#selectedId === fromId) this.#selectedId = message.id;
	}

	registerSegment(segment: NarrationSegment): void {
		const capture = this.#capture;
		if (!capture) return;
		this.#segments.set(segment.id, { capture, sourceOffset: segment.source.start });
		this.#utterances.set(segment.utterance, capture);
		this.#activeUtterance = segment.utterance;
	}

	setSegmentAudio(segmentId: number, start: number, duration: number): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked || !Number.isFinite(start) || !Number.isFinite(duration)) return;
		const absoluteTime = tracked.capture.baseTime + Math.max(0, start);
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

	setPlayback(utterance: number, position: number): void {
		const capture = this.#utterances.get(utterance);
		if (!capture || utterance !== this.#activeUtterance || !Number.isFinite(position)) return;
		capture.record.position = Math.max(0, capture.baseTime + position);
	}

	selected(): PlaybackMessage | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return record ? { id: record.id, text: record.text } : undefined;
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
		return { id: record.id, text: record.text, time: closest.time, sourceOffset: closest.sourceOffset };
	}

	resumeTarget(): PlaybackTarget | undefined {
		return this.seekTarget(0) ?? this.restartTarget();
	}

	hasTimings(): boolean {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return Boolean(record?.checkpoints.length);
	}
}
