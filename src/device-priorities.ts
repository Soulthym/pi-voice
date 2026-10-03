import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface DevicePriorityState {
	readonly version: 1;
	readonly discovery: Readonly<Record<string, { readonly date: number }>>;
	readonly user_order: readonly string[];
}
export interface RankedDevice {
	readonly id: string;
	/** Display only: -1 is local fallback, never a numerically winning rank. */
	readonly priority: number;
	readonly manual: boolean;
	readonly pinned: boolean;
	readonly available: boolean;
}

function validId(id: unknown): id is string {
	return typeof id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(id) && id !== "auto";
}
function known(state: DevicePriorityState, id: string): boolean {
	return id === "local" || Object.hasOwn(state.discovery, id);
}

/** Underlying positive positions include offline and pinned devices. Local fallback is last. */
export function rankDevicePriorities(state: DevicePriorityState, available: ReadonlySet<string>, pin?: string): readonly RankedDevice[] {
	const manual = new Set(state.user_order);
	const order = [...state.user_order, ...Object.keys(state.discovery)
		.filter(id => id !== "local" && !manual.has(id))
		.sort((a, b) => state.discovery[a].date - state.discovery[b].date || (a < b ? -1 : a > b ? 1 : 0))];
	const rows = order.map((id, index) => ({ id, priority: index + 1, manual: manual.has(id), pinned: false, available: available.has(id) }));
	if (!manual.has("local")) rows.push({ id: "local", priority: -1, manual: false, pinned: false, available: available.has("local") });
	const pinned = rows.find(row => row.id === pin);
	return Object.freeze((pinned ? [{ ...pinned, priority: 0, pinned: true }, ...rows.filter(row => row.id !== pin)] : rows).map(row => Object.freeze(row)));
}

function freeze(state: DevicePriorityState): DevicePriorityState {
	for (const entry of Object.values(state.discovery)) Object.freeze(entry);
	Object.freeze(state.discovery);
	Object.freeze(state.user_order);
	return Object.freeze(state);
}

/** Shared discovery/order only. Pin remains in the caller's existing session/config scope.
 * All writes merge an operation into the latest disk state under the same flock convention
 * as SessionCoordinator. Call refresh/discover on events, never from render().
 */
export class DevicePriorityStore {
	#state: DevicePriorityState;
	#ranking?: { state: DevicePriorityState; key: string; rows: readonly RankedDevice[] };
	constructor(readonly file: string) { this.#state = this.#read(); }
	get snapshot(): DevicePriorityState { return this.#state; }
	refresh(): DevicePriorityState {
		const next = this.#read();
		if (JSON.stringify(next) !== JSON.stringify(this.#state)) this.#state = next;
		return this.#state;
	}

	/** Cached event snapshot; availability is supplied by discovery, never probed here. */
	ranking(available: ReadonlySet<string>, pin?: string): readonly RankedDevice[] {
		const key = JSON.stringify([[...available].sort(), pin]);
		if (this.#ranking?.state !== this.#state || this.#ranking.key !== key) {
			this.#ranking = { state: this.#state, key, rows: rankDevicePriorities(this.#state, available, pin) };
		}
		return this.#ranking.rows;
	}

	discover(devices: readonly { id: string; date: number }[]): DevicePriorityState {
		for (const { id, date } of devices) {
			if (!validId(id) || !Number.isFinite(date) || date < 0) throw new Error("Invalid device discovery");
		}
		return this.#mutate(state => {
			for (const { id, date } of devices) {
				if (id === "local") continue;
				const previous = Object.hasOwn(state.discovery, id) ? state.discovery[id].date : Infinity;
				// Preserve the earliest observation even when concurrent discovery events arrive out of order.
				state.discovery[id] = { date: Math.min(previous, date) };
			}
		});
	}

	/** Insert at a zero-based position in the explicit manual prefix, not the automatic tail. */
	place(id: string, index: number): DevicePriorityState {
		if (!validId(id) || !Number.isInteger(index) || index < 0) throw new Error("Invalid device priority");
		return this.#mutate(state => {
			if (!known(state, id)) throw new Error(`Unknown device: ${id}`);
			state.user_order = state.user_order.filter(item => item !== id);
			state.user_order.splice(Math.min(index, state.user_order.length), 0, id);
		});
	}

	/** Omit id to reset all manual priorities. Discovery dates and caller-owned pin are untouched. */
	reset(id?: string): DevicePriorityState {
		if (id !== undefined && !validId(id)) throw new Error("Invalid device ID");
		return this.#mutate(state => { state.user_order = id === undefined ? [] : state.user_order.filter(item => item !== id); });
	}

	/** Remove remembered priority data, not a registration or future discovery. Caller owns pin removal. */
	forget(id: string): DevicePriorityState {
		if (!validId(id)) throw new Error("Invalid device ID");
		return this.#mutate(state => {
			delete state.discovery[id];
			state.user_order = state.user_order.filter(item => item !== id);
		});
	}

	#read(): DevicePriorityState {
		let value: any;
		try { value = JSON.parse(fs.readFileSync(this.file, "utf8")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return freeze({ version: 1, discovery: Object.create(null), user_order: [] });
			throw error; // Corruption is not an empty store: never overwrite it silently.
		}
		if (value?.version !== 1 || !value.discovery || typeof value.discovery !== "object" || Array.isArray(value.discovery)
			|| !Array.isArray(value.user_order)) throw new Error("Invalid device priority store");
		for (const [id, entry] of Object.entries(value.discovery)) {
			const date = (entry as { date?: unknown } | null)?.date;
			if (!validId(id) || id === "local" || typeof date !== "number" || !Number.isFinite(date) || date < 0) throw new Error("Invalid discovery metadata");
		}
		if (new Set(value.user_order).size !== value.user_order.length || value.user_order.some((id: unknown) => !validId(id) || !known(value, id))) {
			throw new Error("Invalid manual device order");
		}
		value.discovery = Object.assign(Object.create(null), value.discovery);
		return freeze(value);
	}

	#mutate(operation: (state: { version: 1; discovery: Record<string, { date: number }>; user_order: string[] }) => void): DevicePriorityState {
		const directory = path.dirname(this.file);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		// Never unlink the lock inode. The inherited open description holds it until close,
		// including after the flock helper exits; a crashed Pi releases it in the kernel.
		const fd = fs.openSync(`${this.file}.lock`, "a", 0o600);
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			const result = spawnSync("flock", ["-w", "5", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
			if (result.error || result.status !== 0) throw new Error("Device priorities require working flock (lock busy or unavailable)", { cause: result.error });
			const current = this.#read();
			const next = { version: 1 as const, discovery: Object.assign(Object.create(null), current.discovery) as Record<string, { date: number }>, user_order: [...current.user_order] };
			operation(next);
			const data = JSON.stringify(next);
			if (data !== JSON.stringify(current)) {
				const output = fs.openSync(temporary, "wx", 0o600);
				try { fs.writeFileSync(output, `${data}\n`); fs.fsyncSync(output); } finally { fs.closeSync(output); }
				fs.renameSync(temporary, this.file);
				const dir = fs.openSync(directory, "r");
				try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
			}
			if (data !== JSON.stringify(this.#state)) this.#state = freeze(next);
			return this.#state;
		} finally {
			try { fs.rmSync(temporary, { force: true }); } finally { fs.closeSync(fd); }
		}
	}
}
