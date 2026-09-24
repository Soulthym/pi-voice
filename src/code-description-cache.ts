import type { CodeNarrationOperation, CodeNarrationPlan } from "./code-narration.js";

export interface CodeDescriptionCacheSnapshot {
	version: 1;
	key: string;
	/** Source identity alias for an adopted legacy key (preserves existing timing identity). */
	identity?: string;
	plan: CodeNarrationPlan;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1;
}

function isId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(value);
}

function isOperation(value: unknown): value is CodeNarrationOperation {
	if (!value || typeof value !== "object" || !("kind" in value) || typeof value.kind !== "string") return false;
	if (value.kind === "reset") return true;
	if (!("id" in value) || !isId(value.id)) return false;
	if (value.kind === "line-remove" || value.kind === "bold-remove") return true;
	if (!("range" in value) || !value.range || typeof value.range !== "object") return false;
	const range = value.range;
	if (!("startLine" in range) || !("endLine" in range)) return false;
	if (!isPositiveInteger(range.startLine) || !isPositiveInteger(range.endLine) || range.endLine < range.startLine) {
		return false;
	}
	if (value.kind === "line-add") return true;
	return (
		value.kind === "bold-add" &&
		"startColumn" in range &&
		"endColumn" in range &&
		isPositiveInteger(range.startColumn) &&
		isPositiveInteger(range.endColumn)
	);
}

export function isCodeNarrationPlan(value: unknown): value is CodeNarrationPlan {
	if (!value || typeof value !== "object" || !("guided" in value) || typeof value.guided !== "boolean") return false;
	if (!("records" in value) || !Array.isArray(value.records) || value.records.length === 0 || value.records.length > 32) {
		return false;
	}
	let speechLength = 0;
	for (const record of value.records) {
		if (!record || typeof record !== "object" || !("speech" in record) || typeof record.speech !== "string") return false;
		if (!("operations" in record) || !Array.isArray(record.operations) || record.operations.length > 8) return false;
		if (!record.operations.every(isOperation)) return false;
		speechLength += record.speech.length;
		if (speechLength > 1_500) return false;
	}
	return value.records.some(record => record.speech.trim().length > 0);
}

export function parseCodeDescriptionCacheSnapshot(value: unknown): CodeDescriptionCacheSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (!("version" in value) || value.version !== 1) return undefined;
	if (!("key" in value) || typeof value.key !== "string" || !/^[a-f0-9]{64}$/.test(value.key)) return undefined;
	if (!("plan" in value) || !isCodeNarrationPlan(value.plan)) return undefined;
	const identity = "identity" in value && typeof value.identity === "string" && /^[a-f0-9]{64}$/.test(value.identity)
		? value.identity : undefined;
	return { version: 1, key: value.key, plan: value.plan, ...(identity ? { identity } : {}) };
}

/** Content-addressed, in-flight-coalescing narration cache for one Pi session. */
export class CodeDescriptionCache {
	#plans = new Map<string, CodeNarrationPlan>();
	#identities = new Map<string, string>();
	#pending = new Map<string, { promise: Promise<CodeNarrationPlan>; controller: AbortController; consumers: number; describing: boolean; listeners: Set<(active: boolean) => void> }>();
	#restoredKeys = new Set<string>();
	#generation = 0;

	restore(values: readonly unknown[]): void {
		this.#generation += 1;
		this.#plans.clear();
		this.#identities.clear();
		for (const pending of this.#pending.values()) pending.controller.abort();
		this.#pending.clear();
		this.#restoredKeys.clear();
		for (const value of values) {
			const snapshot = parseCodeDescriptionCacheSnapshot(value);
			if (snapshot) {
				this.#plans.set(snapshot.key, snapshot.plan);
				this.#restoredKeys.add(snapshot.key);
				if (snapshot.identity) this.#identities.set(snapshot.identity, snapshot.key);
			}
		}
	}

	resolveKey(
		identity: string,
		compatibleKeys?: () => Iterable<string>,
		onAdopt?: (snapshot: CodeDescriptionCacheSnapshot) => void,
	): string {
		const known = this.#identities.get(identity) ?? identity;
		if (known !== identity || this.#plans.has(known)) return known;
		// Only restored assets can need migration; new/empty caches need no old contexts.
		if (!this.#restoredKeys.size) return identity;
		// Compute old serialized identities only on a miss; retain only their hashes.
		for (const candidate of compatibleKeys?.() ?? []) {
			const key = this.#identities.get(candidate) ?? candidate;
			const adopted = this.adopt(identity, key);
			if (!adopted) continue;
			try { onAdopt?.(adopted); } catch { /* Persistence is best-effort. */ }
			return key;
		}
		return identity;
	}

	adopt(identity: string, key: string): CodeDescriptionCacheSnapshot | undefined {
		const plan = this.#plans.get(key);
		if (!plan) return undefined;
		this.#identities.set(identity, key);
		return { version: 1, key, identity, plan };
	}

	get(key: string): CodeNarrationPlan | undefined {
		return this.#plans.get(key);
	}

	/** Drops a cached plan (e.g. an omission) so the next request generates anew. */
	invalidate(key: string): void {
		this.#plans.delete(key);
		this.#restoredKeys.delete(key);
		this.#pending.get(key)?.controller.abort();
		this.#pending.delete(key);
	}

	getOrCreate(
		key: string,
		create: (signal: AbortSignal, onActivity: (active: boolean) => void) => Promise<CodeNarrationPlan>,
		onStore?: (snapshot: CodeDescriptionCacheSnapshot) => void,
		/** Let a joining caller retry a rejection specific to the original caller's policy. */
		retryRejected?: (error: unknown) => boolean,
		signal?: AbortSignal,
		/** Observe this shared producer, including activity already underway when joining. */
		onActivity?: (active: boolean) => void,
	): Promise<CodeNarrationPlan> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		const cached = this.#plans.get(key);
		if (cached) return Promise.resolve(cached);
		const generation = this.#generation;
		let active = this.#pending.get(key);
		const joining = !!active;
		if (!active) {
			const controller = new AbortController();
			const entry = { controller, consumers: 0, describing: false, listeners: new Set<(active: boolean) => void>(), promise: undefined! as Promise<CodeNarrationPlan> };
			const activity = (active: boolean) => {
				if (controller.signal.aborted || this.#pending.get(key) !== entry) return;
				entry.describing = active;
				for (const listener of entry.listeners) listener(active);
			};
			const pending = Promise.resolve()
				.then(() => { controller.signal.throwIfAborted(); return create(controller.signal, activity); })
				.then(plan => {
					controller.signal.throwIfAborted();
					if (generation !== this.#generation) return plan;
					this.#plans.set(key, plan);
					try {
						onStore?.({ version: 1, key, plan });
					} catch {
						// Session persistence is best-effort; narration should still play.
					}
					return plan;
				})
				.finally(() => {
					if (this.#pending.get(key) === entry) this.#pending.delete(key);
				});
			entry.promise = pending;
			this.#pending.set(key, entry);
			active = entry;
		}
		const entry = active;
		entry.consumers += 1;
		if (onActivity) {
			entry.listeners.add(onActivity);
			onActivity(entry.describing);
		}
		const detach = () => {
			if (onActivity && entry.listeners.delete(onActivity)) onActivity(false);
		};
		const result = new Promise<CodeNarrationPlan>((resolve, reject) => {
			const abort = () => { detach(); reject(signal!.reason); };
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			entry.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
		}).finally(() => {
			detach();
			entry.consumers -= 1;
			if (entry.consumers === 0) {
				if (this.#pending.get(key) === entry) this.#pending.delete(key);
				entry.controller.abort();
			}
		});
		return joining && retryRejected ? result.catch(error => {
			if (signal?.aborted || !retryRejected(error) || generation !== this.#generation) throw error;
			return this.getOrCreate(key, create, onStore, retryRejected, signal, onActivity);
		}) : result;
	}
}
