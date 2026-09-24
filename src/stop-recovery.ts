import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DeviceRouter, type DeviceDirection } from "./device-router.js";
import { PhoneInputClient } from "./phone-input.js";
import { stopRemotePlayback, validStreamId } from "./remote-playback.mjs";

export type RecoveryHandle = { endpoint: string; id: string; selection: string; configured: string };
export type RecoveryEpisode = { device: string; cause: string; handles: RecoveryHandle[] };
type Journal = { version: 1; input?: RecoveryEpisode; output?: RecoveryEpisode };

/** Scoped receipts are recoverable; this journal deliberately cannot release a speech fence.
 * ponytail: admission/child coverage is incomplete; add a write-ahead worker handshake before reclaiming orphan leases.
 */
export class StopRecovery {
	readonly file: string;
	#journal: Journal = { version: 1 };
	readonly generations = { input: 0, output: 0 };
	constructor(root: string, instanceId: string) {
		if (!/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) throw new Error("Invalid recovery owner");
		this.file = path.join(root, "stop-recovery", `${instanceId}.json`);
		try {
			// ponytail: keep every unresolved scope in memory; stream the journal if its size becomes operationally significant.
			const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Journal;
			if (value.version !== 1) throw new Error("Invalid recovery journal version");
			for (const direction of ["input", "output"] as const) {
				const episode = value[direction];
				if (episode === undefined) continue;
				if (!episode || typeof episode.device !== "string" || typeof episode.cause !== "string" ||
					!Array.isArray(episode.handles) || episode.handles.some(handle => !validHandle(direction, handle))) {
					throw new Error("Invalid recovery journal");
				}
			}
			this.#journal = value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	episode(direction: DeviceDirection): RecoveryEpisode | undefined {
		const episode = this.#journal[direction];
		return episode && structuredClone(episode);
	}

	retain(direction: DeviceDirection, handle: RecoveryHandle, device: string): void {
		if (!validHandle(direction, handle)) throw new Error("Invalid recovery handle");
		const episode = this.#journal[direction] ??= { device, cause: "Original transport stop not yet confirmed", handles: [] };
		if (!episode.handles.some(existing => existing.id === handle.id)) {
			episode.handles.push({ ...handle });
			this.generations[direction]++;
		}
		this.#save();
	}

	fail(direction: DeviceDirection, device: string, cause: string): void {
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
			else await stopRemotePlayback({ output: route.endpoint, id: handle.id });
			episode.handles = episode.handles.filter(existing => existing.id !== handle.id);
			episode.cause = "Saved scope stopped; interrupted transport coverage remains unproven; ownership retained";
			this.#save();
		}
	}

	#save(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			const fd = fs.openSync(temporary, "wx", 0o600);
			try { fs.writeFileSync(fd, `${JSON.stringify(this.#journal)}\n`); fs.fsyncSync(fd); }
			finally { fs.closeSync(fd); }
			fs.renameSync(temporary, this.file);
			const directory = fs.openSync(path.dirname(this.file), "r");
			try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		} finally { fs.rmSync(temporary, { force: true }); }
	}
}

function validHandle(direction: DeviceDirection, value: RecoveryHandle): boolean {
	return !!value && typeof value.endpoint === "string" && /^(tcp|unix):/.test(value.endpoint) &&
		typeof value.selection === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value.selection) && value.selection !== "auto" &&
		typeof value.configured === "string" && (direction === "output" ? validStreamId(value.id) :
			typeof value.id === "string" && /^[0-9a-f]{32}\.[1-9][0-9]{0,15}$/.test(value.id) && Number.isSafeInteger(Number(value.id.split(".")[1])));
}
