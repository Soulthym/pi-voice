import { SpeakableStream } from "./speakable.js";
import type { NarrationSegment, TimingQuality } from "./narration-progress.js";

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
	timingQuality?: TimingQuality;
	wordTimingCoverage?: { estimated: number; total: number };
}

export interface PlaybackTimingSnapshot {
	version: 3;
	messageId: string;
	renderKey: string;
	duration: number;
	checkpoints: TimingCheckpoint[];
	complete?: boolean;
	units?: Array<{ unit: PlaybackUnit; checkpoints: TimingCheckpoint[]; coverage?: { estimated: number; total: number } }>;
}

type TimingCheckpoint = {
	time: number;
	duration: number;
	sourceOffset: number;
	quality?: TimingQuality;
};

type MessageRecord = PlaybackMessage & {
	checkpoints: TimingCheckpoint[];
	duration: number;
	position: number;
	timingsComplete: boolean;
	cursor?: PlaybackUnit;
	/** Relative checkpoints for compatible units, including suffixes without a known absolute start. */
	units?: Map<string, TimingCheckpoint[]>;
	/** Full source-array counts, never reconstructed from sparse navigation checkpoints. */
	wordTimingCoverage?: Map<string, { estimated: number; total: number } | undefined>;
};

type Capture = {
	valid: boolean;
	renderKey?: string;
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
	timingSuperseded?: boolean;
};

/** Keeps only text-source timing metadata; replayed audio is always regenerated. */
export class PlaybackHistory {
	#records = new Map<string, MessageRecord>();
	#versions = new Map<string, Map<string, MessageRecord>>();
	#snapshots = new Map<string, Map<string, PlaybackTimingSnapshot>>();
	#order: string[] = [];
	#selectedId: string | undefined;
	#capture: Capture | undefined;
	#segments = new Map<number, CapturedSegment>();
	#utterances = new Map<number, Capture>();
	// Vocalizer ids are monotonic; this watermark replaces unbounded retired-id tombstones.
	#latestUtterance = -1;
	#endedUtterances = new Set<number>();
	#finishedUtterances = new Set<number>();
	#activeUtterance: number | undefined;
	#playbackEpoch = 0;
	#persistedUtterances = new Map<number, string>();

	/** Bound historical variants independently of transcript length (current records remain available). */
	#trimVersions(): void {
		const size = (version: MessageRecord | PlaybackTimingSnapshot): number => version.checkpoints.length +
			(version.units instanceof Map ? [...version.units.values()].reduce((sum, points) => sum + points.length, 0)
				: version.units?.reduce((sum, unit) => sum + unit.checkpoints.length, 0) ?? 0);
		for (const cache of [this.#versions, this.#snapshots]) {
			let points = 0;
			for (const versions of cache.values()) for (const version of versions.values()) points += size(version);
			for (const [id, versions] of cache) {
				if (points <= 50_000 && cache.size <= 256) break;
				for (const version of versions.values()) points -= size(version);
				cache.delete(id);
			}
		}
	}

	sync(messages: PlaybackMessage[], selectLatest = false): void {
		this.#order = messages.map(message => message.id);
		for (const message of messages) this.syncMessage(message);
		if (selectLatest || !this.#selectedId || !this.#order.includes(this.#selectedId)) {
			this.#selectedId = this.#order.at(-1);
		}
	}

	/** Update one resolved identity without rebuilding order or disturbing selection. */
	syncMessage(message: PlaybackMessage): void {
		let existing = this.#records.get(message.id);
		const hydrateSnapshot = !existing || (existing.text === message.text && existing.renderKey !== message.renderKey);
		if (existing) {
			if (existing.text !== message.text || existing.renderKey !== message.renderKey) {
				this.invalidateCaptures(message.id);
				if (existing.renderKey) {
					let versions = this.#versions.get(message.id);
					if (!versions) this.#versions.set(message.id, versions = new Map());
					versions.set(existing.renderKey, existing);
					// ponytail: four variants for 256 targets; evicted variants are remeasured.
					if (versions.size > 4) versions.delete(versions.keys().next().value!);
					this.#trimVersions();
				}
				const version = message.renderKey ? this.#versions.get(message.id)?.get(message.renderKey) : undefined;
				const compatible = version?.text === message.text ? version : undefined;
				existing = { ...message, checkpoints: [], duration: 0, position: existing.position,
					cursor: existing.text === message.text ? existing.cursor : undefined, timingsComplete: false,
					...(compatible ? { checkpoints: compatible.checkpoints.map(point => ({ ...point })),
						duration: compatible.duration, timingsComplete: compatible.timingsComplete, units: compatible.units,
						wordTimingCoverage: compatible.wordTimingCoverage && new Map(compatible.wordTimingCoverage) } : {}) };
				this.#records.set(message.id, existing);
			}
			existing.messageType = message.messageType;
			existing.contentIndex = message.contentIndex;
			existing.displayOffset = message.displayOffset;
			existing.text = message.text;
			existing.renderKey = message.renderKey;
		} else this.#records.set(message.id, { ...message, checkpoints: [], duration: 0, position: 0, timingsComplete: false });
		const saved = message.renderKey ? this.#snapshots.get(message.id)?.get(message.renderKey) : undefined;
		const record = this.#records.get(message.id)!;
		// Snapshots hydrate empty records; in-memory partial captures can already be newer.
		if (saved && hydrateSnapshot && !record.checkpoints.length && !record.units?.size) this.restore([saved]);
	}

	restore(snapshots: readonly PlaybackTimingSnapshot[], missingOnly = false): void {
		for (const snapshot of snapshots) {
			if (snapshot.version !== 3 || !Number.isFinite(snapshot.duration) || snapshot.duration < 0) continue;
			if (!snapshot.renderKey || !Array.isArray(snapshot.checkpoints) || snapshot.checkpoints.length > 100_000) continue;
			if (snapshot.units !== undefined && (!Array.isArray(snapshot.units) || snapshot.units.length > 100_000 ||
				snapshot.units.some(unit => !unit || !Array.isArray(unit.checkpoints)) ||
				snapshot.units.reduce((sum, unit) => sum + unit.checkpoints.length, 0) > 100_000)) continue;
			let versions = this.#snapshots.get(snapshot.messageId);
			if (!versions) this.#snapshots.set(snapshot.messageId, versions = new Map());
			versions.set(snapshot.renderKey, snapshot);
			if (versions.size > 4) versions.delete(versions.keys().next().value!);
			this.#trimVersions();
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
			if (checkpoints.length === 0 && !(snapshot.complete === false && snapshot.units?.length)) continue;
			// Recovery may start after live CTC has improved an older persisted partial.
			// Keep its absolute clock; missing relative units are joined at completion.
			const restoreClock = !missingOnly || (!record.checkpoints.length && !record.units?.size);
			for (const saved of snapshot.units ?? []) {
				if (!Number.isInteger(saved.unit?.sourceOffset) || saved.unit.sourceOffset < 0 || saved.unit.sourceOffset >= record.text.length ||
					!Number.isInteger(saved.unit.skipUnits) || saved.unit.skipUnits < 0 || !Array.isArray(saved.checkpoints) ||
					!saved.checkpoints.length || saved.checkpoints.length > 100_000 || saved.checkpoints.some(point =>
						!point || !Number.isFinite(point.time) || point.time < 0 || !Number.isFinite(point.duration) || point.duration < 0 ||
						!Number.isInteger(point.sourceOffset) || point.sourceOffset < 0 || point.sourceOffset >= record.text.length)) continue;
				if (missingOnly && this.timingForUnit(record.id, snapshot.renderKey, saved.unit)) continue;
				this.retainTimingUnit(record.id, snapshot.renderKey, saved.unit, saved.checkpoints);
				const counts = saved.coverage;
				if (counts && Number.isSafeInteger(counts.total) && Number.isSafeInteger(counts.estimated) && counts.estimated >= 0 && counts.total >= counts.estimated) {
					record.wordTimingCoverage ??= new Map();
					record.wordTimingCoverage.set(`${saved.unit.sourceOffset}:${saved.unit.skipUnits}`, { ...counts });
				}
			}
			if (!restoreClock) {
				const ordinals = new Map<number, number>();
				for (const anchor of checkpoints.filter(point => point.duration > 0)) {
					const skipUnits = ordinals.get(anchor.sourceOffset) ?? 0;
					ordinals.set(anchor.sourceOffset, skipUnits + 1);
					const unit = { sourceOffset: anchor.sourceOffset, skipUnits };
					if (this.timingForUnit(record.id, snapshot.renderKey, unit)) continue;
					this.retainTimingUnit(record.id, snapshot.renderKey, unit, checkpoints
						.filter(point => point === anchor || (point.duration === 0 && point.time >= anchor.time && point.time < anchor.time + anchor.duration))
						.map(point => ({ ...point, time: point.time - anchor.time })));
				}
			}
			if (restoreClock) {
				record.checkpoints = checkpoints.map(checkpoint => ({ ...checkpoint })).sort((left, right) => left.time - right.time);
				record.duration = snapshot.duration;
				record.timingsComplete = snapshot.complete !== false;
			}
		}
	}

	/** First resolution labels the plan actually used, rather than retiring its audio. */
	resolveRenderKey(id: string, previous: string, resolved: string): void {
		const record = this.#records.get(id);
		if (!record || record.renderKey !== previous) return;
		record.renderKey = resolved;
		for (const capture of new Set([this.#capture, ...this.#utterances.values()])) {
			if (capture?.valid && capture.record === record && capture.renderKey === previous) capture.renderKey = resolved;
		}
	}

	/** Counts reachable timing storage, including transport references, not just the version pool. */
	timingRetention(): { records: number; checkpoints: number; captures: number; segments: number } {
		const captures = new Set([...this.#utterances.values(), ...(this.#capture ? [this.#capture] : []),
			...[...this.#segments.values()].map(segment => segment.capture)]);
		const records = new Set([...this.#records.values(), ...[...this.#versions.values()].flatMap(versions => [...versions.values()]),
			...[...captures].map(capture => capture.record)]);
		const arrays = new Set([...records].flatMap(record => [record.checkpoints, ...record.units?.values() ?? []]));
		for (const versions of this.#snapshots.values()) for (const snapshot of versions.values()) arrays.add(snapshot.checkpoints);
		return { records: records.size, checkpoints: [...arrays].reduce((sum, points) => sum + points.length, 0),
			captures: captures.size, segments: this.#segments.size };
	}

	/** Freeze metadata before cancelling a dirty transport; late callbacks cannot relabel it. */
	invalidateCaptures(id?: string): void {
		for (const capture of new Set([this.#capture, ...this.#utterances.values()])) {
			if (capture && (id === undefined || capture.record.id === id)) capture.valid = false;
		}
		if (this.#capture && !this.#capture.valid) this.#capture = undefined;
		for (const [utterance, capture] of this.#utterances) if (!capture.valid) {
			this.#utterances.delete(utterance);
			this.#endedUtterances.delete(utterance);
			this.#finishedUtterances.delete(utterance);
			this.#persistedUtterances.delete(utterance);
		}
		for (const [segment, tracked] of this.#segments) if (!tracked.capture.valid) this.#segments.delete(segment);
	}

	beginCapture(id: string, text: string, baseTime = 0, recordTimings = true, sourceOffset = 0, skipUnits = 0, select = true): void {
		this.invalidateCaptures(id);
		let record = this.#records.get(id);
		if (!record) {
			record = { id, text, checkpoints: [], duration: 0, position: baseTime, timingsComplete: false };
			this.#records.set(id, record);
		} else {
			if (record.text !== text) {
				record.checkpoints = [];
				record.units = undefined;
				record.wordTimingCoverage = undefined;
				record.duration = 0;
				record.timingsComplete = false;
			}
			record.text = text;
			record.position = baseTime;
		}
		// Replay selects immediately and fences ticks from the displaced transport.
		// Queued live captures must leave the audible selection and its ticks alone.
		if (select) {
			this.#selectedId = id;
			this.#playbackEpoch++;
			this.#activeUtterance = undefined;
		}
		record.cursor = { sourceOffset, skipUnits };
		this.#capture = { valid: true, renderKey: record.renderKey, epoch: this.#playbackEpoch, record, baseTime,
			recordTimings: recordTimings && baseTime === 0 && sourceOffset === 0 && skipUnits === 0, origin: record.cursor, segments: [] };
	}

	updateText(id: string, text: string, source?: Pick<PlaybackMessage, "messageType" | "contentIndex" | "displayOffset">): void {
		const record = this.#records.get(id);
		if (!record) return;
		if (!text.startsWith(record.text)) {
			this.invalidateCaptures(id);
			record.wordTimingCoverage = undefined;
		}
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
		if (record.text !== message.text) this.invalidateCaptures(fromId);
		if (record.text !== message.text || (record.renderKey && record.renderKey !== message.renderKey)) {
			record.wordTimingCoverage = undefined;
		}
		this.#records.delete(fromId);
		record.messageType = message.messageType;
		record.contentIndex = message.contentIndex;
		record.displayOffset = message.displayOffset;
		record.id = message.id;
		record.text = message.text;
		// A live id is finalized once; never rebind an already-versioned capture.
		for (const capture of new Set([this.#capture, ...this.#utterances.values()])) {
			if (capture?.record === record && capture.valid) {
				if (capture.renderKey && capture.renderKey !== message.renderKey) this.invalidateCaptures(message.id);
				else capture.renderKey = message.renderKey;
			}
		}
		record.renderKey = message.renderKey;
		this.#records.set(message.id, record);
		if (this.#selectedId === fromId) this.#selectedId = message.id;
	}

	/** Bind before async descriptions resolve and another target becomes current. */
	bindUtterance(utterance: number): void {
		if (utterance <= this.#latestUtterance && !this.#utterances.has(utterance)) return;
		this.#latestUtterance = Math.max(this.#latestUtterance, utterance);
		if (this.#capture) this.#utterances.set(utterance, this.#capture);
	}

	registerSegment(segment: NarrationSegment): void {
		const capture = this.#utterances.get(segment.utterance) ??
			(segment.utterance > this.#latestUtterance ? this.#capture : undefined);
		if (!capture?.valid) return;
		this.#latestUtterance = Math.max(this.#latestUtterance, segment.utterance);
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
		capture.record.wordTimingCoverage ??= new Map();
		capture.record.wordTimingCoverage.set(`${sourceOffset}:${skipUnits}`, undefined);
		capture.segments.push(tracked);
		this.#utterances.set(segment.utterance, capture);
	}

	setSegmentAudio(segmentId: number, start: number, duration: number, quality: TimingQuality = "estimated"): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked?.capture.valid || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return;
		const normalizedStart = Math.max(0, start);
		tracked.audioStart = normalizedStart;
		if (tracked.timingSuperseded) return;
		const absoluteTime = tracked.capture.baseTime + normalizedStart;
		const record = tracked.capture.record;
		if (tracked.capture.recordTimings && !record.timingsComplete) {
			const previous = record.units?.get(`${tracked.sourceOffset}:${tracked.skipUnits}`);
			if (previous) {
				record.checkpoints = record.checkpoints.filter(point =>
					point.time < absoluteTime || point.time >= absoluteTime + duration);
			}
			record.checkpoints.push({
				time: absoluteTime,
				duration: Math.max(0, duration),
				sourceOffset: tracked.sourceOffset,
				quality,
			});
			record.checkpoints.sort((left, right) => left.time - right.time);
			record.duration = Math.max(record.duration, absoluteTime + Math.max(0, duration));
			this.#completeTimingsIfReady(tracked.utterance);
		}
		record.units ??= new Map();
		const key = `${tracked.sourceOffset}:${tracked.skipUnits}`;
		record.wordTimingCoverage?.delete(key);
		const words = record.units.get(key)?.slice(1) ?? [];
		record.units.set(key, [{ time: 0, duration, sourceOffset: tracked.sourceOffset, quality }, ...words]);
		this.setTimingQuality(segmentId, quality);
	}

	/** Quality updates are metadata-only, including for code descriptions and paused captures. */
	setTimingQuality(segmentId: number, quality: TimingQuality | undefined): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked?.capture.valid || tracked.timingSuperseded || tracked.audioStart === undefined || !quality) return;
		const record = tracked.capture.record;
		const unit = record.units?.get(`${tracked.sourceOffset}:${tracked.skipUnits}`);
		if (unit?.[0]) unit[0].quality = quality;
		const time = tracked.capture.baseTime + tracked.audioStart;
		// A replay's regenerated clock can differ from the saved timeline.
		const point = record.timingsComplete
			? record.checkpoints.filter(point => point.duration > 0 && point.sourceOffset === tracked.sourceOffset)[tracked.skipUnits]
			: record.checkpoints.find(point => point.duration > 0 && point.time === time && point.sourceOffset === tracked.sourceOffset);
		if (point) point.quality = quality;
	}

	setWordTimings(segmentId: number, words: Array<{ time: number; sourceOffset: number; quality?: TimingQuality }>): void {
		const tracked = this.#segments.get(segmentId);
		if (!tracked?.capture.valid || tracked.timingSuperseded || tracked.audioStart === undefined) return;
		const record = tracked.capture.record;
		const key = `${tracked.sourceOffset}:${tracked.skipUnits}`;
		record.wordTimingCoverage ??= new Map();
		// Code narration offsets address descriptions, not the message's source words.
		const applicable = tracked.code ? [] : words;
		const known = new Set(applicable.map(word => word.sourceOffset)).size === applicable.length &&
			applicable.every(word => Number.isFinite(word.time) && word.time >= 0 &&
			Number.isInteger(word.sourceOffset) &&
			word.sourceOffset - tracked.sourceBase + tracked.capture.origin.sourceOffset >= 0 &&
			word.sourceOffset - tracked.sourceBase + tracked.capture.origin.sourceOffset < record.text.length &&
			(word.quality === "estimated" || word.quality === "ctc-refined"));
		record.wordTimingCoverage.set(key, known && (tracked.code || words.length > 0)
			? { estimated: applicable.filter(word => word.quality === "estimated").length, total: applicable.length }
			: undefined);
		if (tracked.code || words.length === 0) return;
		const relative: TimingCheckpoint[] = [];
		// Replays refine the saved unit's absolute timeline, not the regenerated audio clock.
		const anchor = record.timingsComplete
			? record.checkpoints.filter(point => point.duration > 0 && point.sourceOffset === tracked.sourceOffset)[tracked.skipUnits]
			: undefined;
		const absoluteStart = anchor?.time ?? (tracked.capture.recordTimings
			? tracked.capture.baseTime + tracked.audioStart : undefined);
		const unit = record.units?.get(`${tracked.sourceOffset}:${tracked.skipUnits}`);
		for (const point of unit?.slice(1) ?? []) tracked.wordOffsets.add(point.sourceOffset);
		if (absoluteStart !== undefined) {
			record.checkpoints = record.checkpoints.filter(
				checkpoint => checkpoint.duration > 0 || (anchor
					? checkpoint.time < anchor.time || checkpoint.time >= anchor.time + anchor.duration
					: !tracked.wordOffsets.has(checkpoint.sourceOffset)),
			);
			tracked.wordOffsets.clear();
		}
		let lastTime = Number.NEGATIVE_INFINITY;
		for (const word of words) {
			if (!Number.isFinite(word.time) || word.time < 0 || !Number.isInteger(word.sourceOffset)) continue;
			const absoluteTime = (absoluteStart ?? tracked.capture.baseTime + tracked.audioStart) + word.time;
			const sourceOffset = word.sourceOffset - tracked.sourceBase + tracked.capture.origin.sourceOffset;
			if (sourceOffset < 0 || (sourceOffset === tracked.sourceOffset
				? word.quality !== "ctc-refined" : absoluteTime - lastTime < 0.4)) continue;
			relative.push({ time: word.time, duration: 0, sourceOffset, ...(word.quality ? { quality: word.quality } : {}) });
			if (absoluteStart !== undefined) record.checkpoints.push({ time: absoluteTime, duration: 0, sourceOffset, ...(word.quality ? { quality: word.quality } : {}) });
			tracked.wordOffsets.add(sourceOffset);
			lastTime = absoluteTime;
		}
		record.checkpoints.sort((left, right) => left.time - right.time);
		if (unit) unit.splice(1, unit.length, ...relative);
	}

	/** Recovery is metadata-only: it never selects a message or changes its cursor/position. */
	timingForUnit(messageId: string, renderKey: string, unit: PlaybackUnit): TimingCheckpoint[] | undefined {
		const record = this.#records.get(messageId);
		if (record?.renderKey !== renderKey) return undefined;
		const retained = record.units?.get(`${unit.sourceOffset}:${unit.skipUnits}`);
		if (retained) return retained.map(point => ({ ...point }));
		const anchor = record.checkpoints.filter(point => point.duration > 0 && point.sourceOffset === unit.sourceOffset)[unit.skipUnits];
		return anchor && record.checkpoints.filter(point => point === anchor || (point.duration === 0 && point.time >= anchor.time && point.time < anchor.time + anchor.duration))
			.map(point => ({ ...point, time: point.time - anchor.time }));
	}

	retainTimingUnit(messageId: string, renderKey: string, unit: PlaybackUnit, checkpoints: TimingCheckpoint[], coverage?: { estimated: number; total: number }): void {
		const record = this.#records.get(messageId);
		if (!record || record.renderKey !== renderKey || !checkpoints.length) return;
		record.units ??= new Map();
		const key = `${unit.sourceOffset}:${unit.skipUnits}`;
		record.units.set(key, checkpoints.map(point => ({ ...point })));
		if (coverage) {
			record.wordTimingCoverage ??= new Map();
			record.wordTimingCoverage.set(key, { ...coverage });
		}
	}

	/** Join recovery's absolute clock with current unit metadata after asynchronous measurement. */
	completeRecoveredTimings(snapshot: PlaybackTimingSnapshot): PlaybackTimingSnapshot | undefined {
		const record = this.#records.get(snapshot.messageId);
		if (!record || record.renderKey !== snapshot.renderKey) return;
		const checkpoints: TimingCheckpoint[] = [];
		const units: NonNullable<PlaybackTimingSnapshot["units"]> = [];
		const ordinals = new Map<number, number>();
		for (const anchor of snapshot.checkpoints.filter(point => point.duration > 0)) {
			const skipUnits = ordinals.get(anchor.sourceOffset) ?? 0;
			ordinals.set(anchor.sourceOffset, skipUnits + 1);
			const unit = { sourceOffset: anchor.sourceOffset, skipUnits };
			const current = this.timingForUnit(snapshot.messageId, snapshot.renderKey, unit);
			const compatible = current?.[0].duration === anchor.duration;
			const points = compatible ? current! : snapshot.checkpoints
				.filter(point => point === anchor || (point.duration === 0 && point.time >= anchor.time && point.time < anchor.time + anchor.duration))
				.map(point => ({ ...point, time: point.time - anchor.time }));
			checkpoints.push(...points.map(point => ({ ...point, time: anchor.time + point.time })));
			units.push({ unit, checkpoints: points, coverage: compatible
				? record.wordTimingCoverage?.get(`${unit.sourceOffset}:${unit.skipUnits}`) : undefined });
		}
		const merged = { ...snapshot, checkpoints, units };
		this.restore([merged]);
		return merged;
	}

	/** Sparse mixed units are safe only when every refined source word is retained. */
	retryableTimingUnit(messageId: string, renderKey: string, unit: PlaybackUnit, sourceWords: number[]): boolean {
		const points = this.timingForUnit(messageId, renderKey, unit);
		if (!points?.length) return false;
		if (new Set(sourceWords).size !== sourceWords.length ||
			sourceWords.some((offset, i) => !Number.isInteger(offset) || offset < unit.sourceOffset ||
				(i > 0 && offset <= sourceWords[i - 1]))) return false;
		const coverage = this.#records.get(messageId)?.wordTimingCoverage?.get(`${unit.sourceOffset}:${unit.skipUnits}`);
		if (points.every(point => point.quality === "estimated")) return !coverage || coverage.estimated === coverage.total;
		if (!sourceWords.length) return false;
		const words = points.slice(1);
		if (new Set(words.map(word => word.sourceOffset)).size !== words.length || words.some(word =>
			!sourceWords.includes(word.sourceOffset) || !Number.isFinite(word.time) || word.time < 0 || word.time >= points[0].duration ||
			(word.quality !== "estimated" && word.quality !== "ctc-refined"))) return false;
		const refined = words.filter(word => word.quality === "ctc-refined").length;
		const dense = words.length === sourceWords.length;
		return refined < sourceWords.length && (dense || !!coverage && coverage.total === sourceWords.length &&
			Number.isInteger(coverage.estimated) && coverage.estimated >= 0 && coverage.estimated <= coverage.total &&
			coverage.total - coverage.estimated === refined);
	}

	/** Cache-only refinement: never touches capture, selection or clocks. */
	refineTimingUnit(messageId: string, renderKey: string, unit: PlaybackUnit, checkpoints: TimingCheckpoint[], coverage: { estimated: number; total: number }, sourceWords?: number[]): PlaybackTimingSnapshot | undefined {
		const record = this.#records.get(messageId);
		const previous = this.timingForUnit(messageId, renderKey, unit);
		// Revalidate current provenance after asynchronous alignment/recovery, not the invocation snapshot.
		if (!record || !previous?.length || !checkpoints.length ||
			(sourceWords ? !this.retryableTimingUnit(messageId, renderKey, unit, sourceWords) : previous.some(point => point.quality !== "estimated")) ||
			previous[0].duration !== checkpoints[0].duration) return;
		if (sourceWords?.length) {
			const words = checkpoints.slice(1);
			if (words.length !== sourceWords.length || words.some((word, i) => word.sourceOffset !== sourceWords[i] ||
				(word.quality !== "estimated" && word.quality !== "ctc-refined"))) return;
			const retained = new Map(previous.slice(1).map(word => [word.sourceOffset, word]));
			const merged = words.map(word => retained.has(word.sourceOffset) &&
				(retained.get(word.sourceOffset)!.quality === "ctc-refined" || word.quality === "estimated")
				? { ...retained.get(word.sourceOffset)! } : { ...word });
			// Incompatible candidates are skipped, never repaired by moving an old CTC anchor.
			if (merged.some((word, i) => !Number.isFinite(word.time) || word.time < 0 || word.time >= previous[0].duration ||
				(i > 0 && word.time <= merged[i - 1].time))) return;
			coverage = { total: merged.length, estimated: merged.filter(word => word.quality === "estimated").length };
			const quality = coverage.estimated === 0 ? "ctc-refined" : coverage.estimated === coverage.total ? "estimated" : "mixed";
			checkpoints = [{ ...previous[0], quality }, ...merged];
		}
		const anchor = record.checkpoints.filter(point => point.duration > 0 && point.sourceOffset === unit.sourceOffset)[unit.skipUnits];
		if (anchor) {
			record.checkpoints = record.checkpoints.filter(point => point !== anchor && !(point.duration === 0 && point.time >= anchor.time && point.time < anchor.time + anchor.duration));
			record.checkpoints.push(...checkpoints.map(point => ({ ...point, time: anchor.time + point.time })));
			record.checkpoints.sort((a, b) => a.time - b.time);
		}
		this.retainTimingUnit(messageId, renderKey, unit, checkpoints);
		// Only improved retries retire original metadata; an estimated retry must leave pending CTC eligible.
		for (const segment of this.#segments.values()) {
			if (segment.capture.record === record && segment.sourceOffset === unit.sourceOffset && segment.skipUnits === unit.skipUnits) {
				segment.timingSuperseded = checkpoints.some(point => point.quality === "ctc-refined" || point.quality === "mixed");
			}
		}
		record.wordTimingCoverage ??= new Map();
		record.wordTimingCoverage.set(`${unit.sourceOffset}:${unit.skipUnits}`, coverage);
		const snapshot: PlaybackTimingSnapshot = { version: 3, messageId, renderKey, duration: record.duration, complete: record.timingsComplete,
			checkpoints: record.checkpoints.map(point => ({ ...point })),
			units: [...record.units ?? []].map(([key, points]) => {
				const [sourceOffset, skipUnits] = key.split(":").map(Number);
				return { unit: { sourceOffset, skipUnits }, checkpoints: points.map(point => ({ ...point })), coverage: record.wordTimingCoverage?.get(key) };
			}) };
		let versions = this.#snapshots.get(messageId);
		if (!versions) this.#snapshots.set(messageId, versions = new Map());
		versions.set(renderKey, snapshot);
		if (versions.size > 4) versions.delete(versions.keys().next().value!);
		this.#trimVersions();
		return snapshot;
	}

	snapshotForSegment(segmentId: number): PlaybackTimingSnapshot | undefined {
		const segment = this.#segments.get(segmentId);
		return segment ? this.snapshotForUtterance(segment.utterance) : undefined;
	}

	snapshotForUtterance(utterance: number): PlaybackTimingSnapshot | undefined {
		const capture = this.#utterances.get(utterance);
		if (
			!capture?.valid ||
			capture.record.id.startsWith("live:") ||
			capture.record.checkpoints.length === 0 ||
			!capture.record.timingsComplete
		) {
			return undefined;
		}
		if (!capture.renderKey || capture.renderKey !== capture.record.renderKey) return undefined;
		// Keep sentence boundaries intact; word checkpoints are already rate-limited.
		const persisted = capture.record.checkpoints;
		const snapshot: PlaybackTimingSnapshot = {
			version: 3,
			messageId: capture.record.id,
			renderKey: capture.renderKey,
			duration: capture.record.duration,
			checkpoints: persisted.map(checkpoint => ({ ...checkpoint })),
			units: [...capture.record.units ?? []].map(([key, points]) => {
				const [sourceOffset, skipUnits] = key.split(":").map(Number);
				return { unit: { sourceOffset, skipUnits }, checkpoints: points.map(point => ({ ...point })), coverage: capture.record.wordTimingCoverage?.get(key) };
			}),
		};
		// Compare the persisted content so duplicate events do not append duplicate revisions.
		const revision = JSON.stringify(snapshot);
		if (this.#persistedUtterances.get(utterance) === revision) return undefined;
		this.#persistedUtterances.set(utterance, revision);
		return snapshot;
	}

	finishTimingGeneration(utterance: number): void {
		if (!this.#utterances.has(utterance)) return;
		this.#endedUtterances.add(utterance);
		this.#completeTimingsIfReady(utterance);
	}

	finishUtterance(utterance: number | undefined, advanceCursor = true): void {
		if (utterance === undefined || !this.#utterances.has(utterance)) return;
		this.#finishedUtterances.add(utterance);
		this.#endedUtterances.add(utterance);
		this.#completeTimingsIfReady(utterance);
		const capture = this.#utterances.get(utterance);
		if (!advanceCursor || !capture?.valid || capture.epoch !== this.#playbackEpoch ||
			(this.#activeUtterance !== undefined && utterance !== this.#activeUtterance)) return;
		const last = capture.segments.at(-1);
		if (last) capture.record.cursor = { sourceOffset: last.sourceOffset, skipUnits: last.skipUnits };
		if (capture.record.timingsComplete) capture.record.position = capture.record.duration;
	}

	#completeTimingsIfReady(utterance: number): void {
		if (!this.#endedUtterances.has(utterance)) return;
		const capture = this.#utterances.get(utterance);
		if (!capture?.valid || !capture.recordTimings) return;
		const segments = [...this.#segments.values()].filter(
			tracked => tracked.capture === capture && tracked.utterance === utterance,
		);
		if (segments.length > 0 && segments.every(segment => segment.audioStart !== undefined)) {
			capture.record.timingsComplete = true;
		}
	}

	setPlayback(utterance: number, position: number): void {
		const capture = this.#utterances.get(utterance);
		if (!capture?.valid || capture.epoch !== this.#playbackEpoch || this.#finishedUtterances.has(utterance) || !Number.isFinite(position) ||
			(this.#activeUtterance !== undefined && utterance < this.#activeUtterance)) return;
		// Utterance ids follow playback order, not asynchronous registration order.
		this.#activeUtterance = utterance;
		this.#selectedId = capture.record.id;
		capture.record.position = Math.max(0, capture.baseTime + position);
		const segment = capture.segments.findLast(segment => segment.audioStart !== undefined && segment.audioStart <= position);
		if (segment) capture.record.cursor = { sourceOffset: segment.sourceOffset, skipUnits: segment.skipUnits };
	}

	/** Follow the foreground capture without inventing a playback tick or resetting its cursor. */
	selectCapture(utterance?: number): void {
		const capture = utterance === undefined ? this.#capture : this.#utterances.get(utterance);
		if (capture?.valid) this.#selectedId = capture.record.id;
	}

	selected(includeIdentity = false): PlaybackMessage | undefined {
		const record = this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		return record ? { id: record.id, text: record.text, ...(includeIdentity ? { renderKey: record.renderKey } : {}), ...(record.messageType ? { messageType: record.messageType, contentIndex: record.contentIndex, displayOffset: record.displayOffset } : {}) } : undefined;
	}

	status(utterance?: number): PlaybackStatus | undefined {
		const record = utterance !== undefined ? this.#utterances.get(utterance)?.record
			: this.#selectedId ? this.#records.get(this.#selectedId) : undefined;
		if (!record) return undefined;
		const index = this.#order.indexOf(record.id);
		const qualities = record.checkpoints.filter(point => point.duration > 0).map(point => point.quality);
		// Sought suffixes retain relative unit timing without absolute checkpoints.
		for (const unit of record.units?.values() ?? []) if (unit[0]) qualities.push(unit[0].quality);
		const known = qualities.filter(quality => quality === "estimated" || quality === "mixed" || quality === "ctc-refined");
		const timingQuality = known.length === 0 ? undefined
			: known.length === qualities.length && known.every(quality => quality === known[0]) ? known[0] : "mixed";
		// Include restored/recovered units: their sparse checkpoints cannot supply counts.
		const keys = new Set([...record.units?.keys() ?? [], ...record.wordTimingCoverage?.keys() ?? []]);
		const ordinals = new Map<number, number>();
		for (const point of record.checkpoints) if (point.duration > 0) {
			const ordinal = ordinals.get(point.sourceOffset) ?? 0;
			keys.add(`${point.sourceOffset}:${ordinal}`);
			ordinals.set(point.sourceOffset, ordinal + 1);
		}
		let wordTimingCoverage: PlaybackStatus["wordTimingCoverage"] = { estimated: 0, total: 0 };
		for (const key of keys) {
			const coverage = record.wordTimingCoverage?.get(key);
			if (!coverage) { wordTimingCoverage = undefined; break; }
			wordTimingCoverage.estimated += coverage.estimated;
			wordTimingCoverage.total += coverage.total;
		}
		if (!wordTimingCoverage?.total) wordTimingCoverage = undefined;
		return {
			messageId: record.id,
			position: Math.max(0, record.timingsComplete ? Math.min(record.duration, record.position) : record.position),
			duration: record.duration,
			messageIndex: index,
			messageCount: this.#order.length,
			hasTimings: record.checkpoints.length > 0,
			timingsComplete: record.timingsComplete,
			timingQuality,
			...(wordTimingCoverage ? { wordTimingCoverage } : {}),
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
