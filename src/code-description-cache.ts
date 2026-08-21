import type { CodeNarrationOperation, CodeNarrationPlan } from "./code-narration.js";

export interface CodeDescriptionCacheSnapshot {
	version: 1;
	key: string;
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

function isPlan(value: unknown): value is CodeNarrationPlan {
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
	if (!("plan" in value) || !isPlan(value.plan)) return undefined;
	return { version: 1, key: value.key, plan: value.plan };
}

/** Content-addressed, in-flight-coalescing narration cache for one Pi session. */
export class CodeDescriptionCache {
	#plans = new Map<string, CodeNarrationPlan>();
	#pending = new Map<string, Promise<CodeNarrationPlan>>();
	#generation = 0;

	restore(values: readonly unknown[]): void {
		this.#generation += 1;
		this.#plans.clear();
		this.#pending.clear();
		for (const value of values) {
			const snapshot = parseCodeDescriptionCacheSnapshot(value);
			if (snapshot) this.#plans.set(snapshot.key, snapshot.plan);
		}
	}

	get(key: string): CodeNarrationPlan | undefined {
		return this.#plans.get(key);
	}

	getOrCreate(
		key: string,
		create: () => Promise<CodeNarrationPlan>,
		onStore?: (snapshot: CodeDescriptionCacheSnapshot) => void,
	): Promise<CodeNarrationPlan> {
		const cached = this.#plans.get(key);
		if (cached) return Promise.resolve(cached);
		const active = this.#pending.get(key);
		if (active) return active;

		const generation = this.#generation;
		const pending = Promise.resolve()
			.then(create)
			.then(plan => {
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
				if (this.#pending.get(key) === pending) this.#pending.delete(key);
			});
		this.#pending.set(key, pending);
		return pending;
	}
}
