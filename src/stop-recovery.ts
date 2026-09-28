import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DeviceRouter, type DeviceDirection } from "./device-router.js";
import { PhoneInputClient } from "./phone-input.js";
import { stopRemotePlayback, validStreamId, validBootId } from "./remote-playback.mjs";

export type RecoveryHandle = { endpoint: string; id: string; selection: string; configured: string; bootId?: string };
export type RecoveryEpisode = { device: string; cause: string; handles: RecoveryHandle[] };
type Journal = { input?: RecoveryEpisode; output?: RecoveryEpisode } & (
	{ version: 1 } | { version: 2; owner: string; admission: Record<DeviceDirection, "idle" | "uncertain"> }
);

/** Only a freshly initialized, never-admitted owner proves orphan recovery safe.
 * ponytail: uncertainty is monotonic for this owner's lifetime; full transport accounting is needed to reset it.
 */
export class StopRecovery {
	readonly file: string;
	#journal: Journal = { version: 1 };
	readonly generations = { input: 0, output: 0 };
	#exists = false;
	#syncThrough: string | undefined;
	constructor(root: string, private readonly instanceId: string) {
		if (!/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) throw new Error("Invalid recovery owner");
		this.file = path.join(root, "stop-recovery", `${instanceId}.json`);
		try {
			// ponytail: keep every unresolved scope in memory; stream the journal if its size becomes operationally significant.
			const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Journal;
			if (value.version !== 1 && value.version !== 2) throw new Error("Invalid recovery journal version");
			if (value.version === 2 && (value.owner !== instanceId || !value.admission ||
				!["idle", "uncertain"].includes(value.admission.input) || !["idle", "uncertain"].includes(value.admission.output))) {
				throw new Error("Invalid recovery admission ledger");
			}
			for (const direction of ["input", "output"] as const) {
				const episode = value[direction];
				if (episode === undefined) continue;
				if (!episode || typeof episode.device !== "string" || typeof episode.cause !== "string" ||
					!Array.isArray(episode.handles) || episode.handles.some(handle => !validHandle(direction, handle))) {
					throw new Error("Invalid recovery journal");
				}
			}
			this.#journal = value;
			this.#exists = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	/** Fresh random owner only. Never upgrade missing/legacy evidence for an old owner. */
	initialize(): void {
		if (this.#exists || fs.existsSync(this.file)) throw new Error("Recovery owner already exists");
		this.#journal = { version: 2, owner: this.instanceId, admission: { input: "idle", output: "idle" } };
		this.#save();
	}

	isIdle(direction: DeviceDirection): boolean {
		return this.#exists && this.#journal.version === 2 && this.#journal.admission[direction] === "idle" && !this.#journal[direction];
	}

	/** Must finish durably BEFORE sending work that could open a player or recorder. */
	beforeIO(direction: DeviceDirection): void {
		if (!this.#exists || this.#journal.version !== 2) throw new Error("Admission ledger unavailable");
		this.#journal.admission[direction] = "uncertain";
		// Always persist, including retries after a failed fsync. Memory is not durability proof.
		this.#save();
	}

	episode(direction: DeviceDirection): RecoveryEpisode | undefined {
		const episode = this.#journal[direction];
		return episode && structuredClone(episode);
	}

	retain(direction: DeviceDirection, handle: RecoveryHandle, device: string): void {
		if (!validHandle(direction, handle)) throw new Error("Invalid recovery handle");
		if (this.#journal.version === 2) this.#journal.admission[direction] = "uncertain";
		const episode = this.#journal[direction] ??= { device, cause: "Original transport stop not yet confirmed", handles: [] };
		const existing = episode.handles.find(existing => existing.id === handle.id);
		if (direction === "output" && existing && (existing.endpoint !== handle.endpoint || existing.bootId !== handle.bootId || existing.selection !== handle.selection || existing.configured !== handle.configured)) throw new Error("Recovery scope identity changed");
		if (!existing) {
			if (direction === "output" && episode.handles.length >= 256) throw new Error("Output recovery scope limit reached; dispatch denied");
			episode.handles.push({ ...handle });
			this.generations[direction]++;
		}
		this.#save();
	}

	fail(direction: DeviceDirection, device: string, cause: string): void {
		if (this.#journal.version === 2) this.#journal.admission[direction] = "uncertain";
		const episode = this.#journal[direction] ??= { device, cause, handles: [] };
		episode.cause = cause;
		this.#save();
	}

	retire(direction: DeviceDirection, id: string, endpoint?: string): void {
		const episode = this.#journal[direction];
		const matches = (handle: RecoveryHandle) => handle.id === id && (endpoint === undefined || handle.endpoint === endpoint);
		if (!episode?.handles.some(matches)) return;
		const handles = episode.handles;
		episode.handles = handles.filter(handle => !matches(handle));
		try { this.#save(); }
		catch (error) { episode.handles = handles; throw error; }
	}

	clear(direction: DeviceDirection): void {
		delete this.#journal[direction];
		this.#save();
	}

	/** Validate the original selection against current configured metadata, never the new pin.
	 * Even after every saved receipt, a crash may have lost another admission: retain the fence.
	 */
	async retry(direction: DeviceDirection, router: DeviceRouter, configured: string): Promise<void> {
		const episode = this.#journal[direction];
		if (!episode) return;
		if (!episode.handles.length) throw new Error(`${episode.device}: no retained ${direction} scope; ownership retained`);
		for (const handle of [...episode.handles]) {
			if (handle.configured !== configured) throw new Error(`${episode.device}: ${direction} configuration changed; ownership retained`);
			const route = router.routeMetadata(handle.selection, direction, configured);
			// A different socket can be the same registered device after reconnect, but custom
			// endpoints must remain exact. Local child processes cannot be reconstructed safely.
			if (route.kind === "disabled" || route.kind === "intentional_local" ||
				(route.kind === "custom" && route.endpoint !== handle.endpoint)) throw new Error("Original recovery route unavailable");
			if (direction === "input") await PhoneInputClient.retryStop({ endpoint: route.endpoint, ticket: handle.id });
			else await stopRemotePlayback({ output: route.endpoint, id: handle.id, bootId: handle.bootId });
			episode.handles = episode.handles.filter(existing => existing.id !== handle.id);
			episode.cause = "Saved scope stopped; interrupted transport coverage remains unproven; ownership retained";
			this.#save();
		}
	}

	#save(): void {
		const firstCreated = fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		// Keep the publication boundary until every fsync succeeds, even if a retry's mkdir creates nothing.
		this.#syncThrough ??= firstCreated ? path.dirname(path.resolve(firstCreated)) : path.resolve(path.dirname(this.file));
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			const fd = fs.openSync(temporary, "wx", 0o600);
			try { fs.writeFileSync(fd, `${JSON.stringify(this.#journal)}\n`); fs.fsyncSync(fd); }
			finally { fs.closeSync(fd); }
			fs.renameSync(temporary, this.file);
			// Persist the journal directory and each newly published parent entry, not unrelated ancestors.
			for (let name = path.resolve(path.dirname(this.file)); ; name = path.dirname(name)) {
				const directory = fs.openSync(name, "r");
				try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
				if (name === this.#syncThrough) break;
			}
			this.#syncThrough = undefined;
			this.#exists = true;
		} finally { fs.rmSync(temporary, { force: true }); }
	}
}

function validHandle(direction: DeviceDirection, value: RecoveryHandle): boolean {
	return !!value && typeof value.endpoint === "string" && /^(tcp|unix):/.test(value.endpoint) &&
		typeof value.selection === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value.selection) && value.selection !== "auto" &&
		typeof value.configured === "string" && (direction === "output" ? validStreamId(value.id) && (value.bootId === undefined || validBootId(value.bootId)) :
			typeof value.id === "string" && /^[0-9a-f]{32}\.[1-9][0-9]{0,15}$/.test(value.id) && Number.isSafeInteger(Number(value.id.split(".")[1])));
}
