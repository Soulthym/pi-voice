import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DeviceRouter, type DeviceDirection } from "./device-router.js";
import { PhoneInputClient } from "./phone-input.js";
import { stopRemotePlayback, validStreamId, validBootId } from "./remote-playback.mjs";

export type RecoveryHandle = { endpoint: string; id: string; selection: string; configured: string; bootId?: string | null; rebootSafe?: boolean; desktopWait?: boolean };
export type RecoveryEpisode = { device: string; cause: string; handles: RecoveryHandle[] };
type Journal = { input?: RecoveryEpisode; output?: RecoveryEpisode } & (
	{ version: 1 } | { version: 2 | 3 | 4; owner: string; admission: Record<DeviceDirection, "idle" | "uncertain" | "covered"> }
);

/** v4 adds scoped desktop input waits; legacy and unknown admission stays fenced. */
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
			if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) throw new Error("Invalid recovery journal version");
			if (value.version !== 1 && (value.owner !== instanceId || !value.admission ||
				!(value.version === 4 ? ["idle", "uncertain", "covered"] : ["idle", "uncertain"]).includes(value.admission.input) || !(value.version >= 3 ? ["idle", "uncertain", "covered"] : ["idle", "uncertain"]).includes(value.admission.output))) {
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
			if (value.version !== 1 && value.version >= 3 && value.admission.output === "covered" && value.output?.handles.some(handle => !(handle.bootId === null || validBootId(handle.bootId)))) throw new Error("Invalid covered output scope");
			if (value.version === 4 && value.admission.input === "covered" && value.input?.handles.some(handle => handle.endpoint !== "local" || handle.desktopWait !== true || !validBootId(handle.bootId))) throw new Error("Invalid covered input scope");
			this.#journal = value;
			this.#exists = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	/** Fresh random owner only. Never upgrade missing/legacy evidence for an old owner. */
	initialize(): void {
		if (this.#exists || fs.existsSync(this.file)) throw new Error("Recovery owner already exists");
		this.#journal = { version: 4, owner: this.instanceId, admission: { input: "idle", output: "idle" } };
		this.#save();
	}

	isIdle(direction: DeviceDirection): boolean {
		return this.#exists && this.#journal.version !== 1 && this.#journal.admission[direction] === "idle" && !this.#journal[direction];
	}

	/** Must finish durably BEFORE sending work that could open a player or recorder. */
	beforeIO(direction: DeviceDirection, preparedOutput = false, preparedDesktopInput = false): void {
		if (!this.#exists || this.#journal.version === 1) throw new Error("Admission ledger unavailable");
		this.#journal.admission[direction] = this.#journal.admission[direction] !== "uncertain" &&
			(direction === "output" && preparedOutput && this.#journal.version >= 3 || direction === "input" && preparedDesktopInput && this.#journal.version === 4) ? "covered" : "uncertain";
		// Always persist, including retries after a failed fsync. Memory is not durability proof.
		this.#save();
	}

	episode(direction: DeviceDirection): RecoveryEpisode | undefined {
		const episode = this.#journal[direction];
		return episode && structuredClone(episode);
	}

	retain(direction: DeviceDirection, handle: RecoveryHandle, device: string): void {
		if (!validHandle(direction, handle)) throw new Error("Invalid recovery handle");
		if (this.#journal.version !== 1) this.#journal.admission[direction] = this.#journal.admission[direction] !== "uncertain" &&
			(direction === "output" && this.#journal.version >= 3 && (handle.bootId === null || validBootId(handle.bootId)) ||
				direction === "input" && this.#journal.version === 4 && handle.endpoint === "local" && handle.desktopWait === true && validBootId(handle.bootId)) ? "covered" : "uncertain";
		const episode = this.#journal[direction] ??= { device, cause: "Original transport stop not yet confirmed", handles: [] };
		const existing = episode.handles.find(existing => existing.id === handle.id);
		if (existing && (existing.endpoint !== handle.endpoint || existing.bootId !== handle.bootId || existing.rebootSafe !== handle.rebootSafe || existing.desktopWait !== handle.desktopWait || existing.selection !== handle.selection || existing.configured !== handle.configured)) throw new Error("Recovery scope identity changed");
		if (!existing) {
			if (direction === "output" && episode.handles.length >= 256) throw new Error("Output recovery scope limit reached; dispatch denied");
			episode.handles.push({ ...handle });
			this.generations[direction]++;
		}
		this.#save();
	}

	fail(direction: DeviceDirection, device: string, cause: string): void {
		// A failed stop does not lose coverage: every possible dispatch is still listed.
		if (this.#journal.version !== 1 && this.#journal.admission[direction] !== "covered") this.#journal.admission[direction] = "uncertain";
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
		if (this.#journal[direction]?.handles.length) return;
		const previous = structuredClone(this.#journal);
		delete this.#journal[direction];
		if (this.#journal.version !== 1 && this.#journal.admission[direction] === "covered") this.#journal.admission[direction] = "idle";
		try { this.#save(); } catch (error) { this.#journal = previous; throw error; }
	}

	/** Only retry a dead owner's scopes, using original selection, never the new pin. */
	async retry(direction: DeviceDirection, router: DeviceRouter, configured: string): Promise<void> {
		const episode = this.#journal[direction];
		if (this.#journal.version !== 1 && this.#journal.admission[direction] === "covered" && !episode?.handles.length) { this.clear(direction); return; }
		if (!episode) return;
		if (!episode.handles.length) throw new Error(`${episode.device}: no retained ${direction} scope; ownership retained`);
		for (const handle of [...episode.handles]) {
			if (handle.configured !== configured) throw new Error(`${episode.device}: ${direction} configuration changed; ownership retained`);
			const route = router.routeMetadata(handle.selection, direction, configured);
			// A different socket can be the same registered device after reconnect, but custom
			// endpoints must remain exact. Local input retries require the new wait protocol;
			// never reconstruct a child or promote an old local scope.
			const desktopWait = direction === "input" && this.#journal.version === 4 && handle.endpoint === "local" && handle.desktopWait === true && route.kind === "intentional_local";
			if (route.kind === "disabled" || route.kind === "intentional_local" && !desktopWait ||
				(route.kind === "custom" && route.endpoint !== handle.endpoint)) throw new Error("Original recovery route unavailable");
			if (direction === "input") await PhoneInputClient.retryStop({ endpoint: route.endpoint, ticket: handle.id, ...(desktopWait ? { bootId: handle.bootId, desktopWait: true } : {}) });
			else await stopRemotePlayback({ output: route.endpoint, id: handle.id, bootId: handle.bootId, deviceId: handle.selection,
				// Only an original registered identity can attest a moved endpoint. Legacy
				// loopback/custom addresses are not device identities, even when unchanged.
				allowReboot: this.#journal.version !== 1 && this.#journal.version >= 3 && handle.rebootSafe === true &&
					route.kind === "device" && route.device.id === handle.selection && handle.selection !== "legacy-loopback",
			});
			this.retire(direction, handle.id, handle.endpoint);
			episode.cause = "Saved scope stopped; interrupted transport coverage remains unproven; ownership retained";
			this.#save();
		}
		if (this.#journal.version !== 1 && this.#journal.admission[direction] === "covered") this.clear(direction);
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
	return !!value && typeof value.endpoint === "string" && value.endpoint.length <= 4096 && (/^(tcp|unix):/.test(value.endpoint) || direction === "input" && value.endpoint === "local") &&
		typeof value.selection === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value.selection) && value.selection !== "auto" &&
		typeof value.configured === "string" && value.configured.length <= 4096 && (direction === "output" ? validStreamId(value.id) && (value.bootId === undefined || value.bootId === null || validBootId(value.bootId)) &&
			(value.rebootSafe === undefined || typeof value.rebootSafe === "boolean") :
			(value.desktopWait === undefined || value.desktopWait === true && value.endpoint === "local" && validBootId(value.bootId)) && typeof value.id === "string" && /^[0-9a-f]{32}\.[1-9][0-9]{0,15}$/.test(value.id) && Number.isSafeInteger(Number(value.id.split(".")[1])) && (value.bootId === undefined || validBootId(value.bootId)));
}
