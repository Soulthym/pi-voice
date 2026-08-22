import * as os from "node:os";
import type { VoiceModelDtype, VoicePreprocessConcurrency } from "./config.js";

const AUTO_LIMIT = 4;

export interface PreprocessingResources {
	availableMemory: number;
	parallelism: number;
}

function systemResources(): PreprocessingResources {
	return {
		availableMemory: os.freemem(),
		parallelism: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
	};
}

export function resolveTimingConcurrency(
	configured: VoicePreprocessConcurrency,
	dtype: VoiceModelDtype,
	resources: PreprocessingResources = systemResources(),
): number {
	if (configured !== "auto") return configured;
	// Kokoro currently runs explicitly on CPU. Each lane owns a process and model,
	// so cap by both CPU capacity and conservative per-worker resident memory.
	const bytesPerWorker = dtype === "fp32" ? 1.25 * 1024 ** 3 : 0.75 * 1024 ** 3;
	const memoryLanes = Math.max(1, Math.floor(resources.availableMemory / bytesPerWorker));
	const cpuLanes = Math.max(1, Math.floor(resources.parallelism / 2));
	return Math.max(1, Math.min(AUTO_LIMIT, memoryLanes, cpuLanes));
}

export function prioritizeFromCurrent<T extends { id: string }>(items: readonly T[], currentId?: string): T[] {
	if (items.length === 0) return [];
	const found = currentId ? items.findIndex(item => item.id === currentId) : -1;
	const current = found >= 0 ? found : items.length - 1;
	return [...items.slice(current), ...items.slice(0, current).reverse()];
}

export async function processConcurrently<T>(
	items: readonly T[],
	concurrency: number,
	process: (item: T, lane: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	const lane = async (laneIndex: number): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			await process(items[index], laneIndex);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, index) => lane(index)));
}
