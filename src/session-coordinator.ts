import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectionDevice } from "./connection-device.js";
import { StopRecovery } from "./stop-recovery.js";

export interface SessionPresence {
	interactive: true;
	instanceId: string;
	pid: number;
	cwd: string;
	updatedAt: number;
	/** Stable Pi session id; older presences may omit it. */
	sessionId?: string;
	/** Human-readable Pi session title; used for spoken labels. */
	sessionName?: string;
	attentionEnabled?: boolean;
	attentionEpoch?: number;
	/** Unique acquisition identity; legacy leases have none. */
	speechGeneration?: string;
}

export interface WaitingSession extends SessionPresence {
	/** Immutable for one pending batch; clearWaiting starts a new generation. */
	readonly generation: string;
	waitingSince: number;
	announced: boolean;
	/** Proven origin output, never inferred from registered-device order. */
	connection?: ConnectionDevice;
}

export interface AttentionRequest {
	requestedAt: number;
	requestedBy: string;
	requestId: string;
	receiverEpoch?: number;
	connection?: ConnectionDevice;
}

type Lease = SessionPresence & { kind: string };

const HEARTBEAT_MS = 1_000;
const STALE_MS = 8_000;
const SPEECH_HANDOFF_TIMEOUT_MS = 1_500;
const SPEECH_HANDOFF_POLL_MS = 25;

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown, durable = false): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	if (durable) {
		const fd = fs.openSync(temporary, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	}
	fs.renameSync(temporary, file);
	if (durable) for (const directory of [path.dirname(file), path.dirname(path.dirname(file))]) {
		const fd = fs.openSync(directory, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	}
}

function remove(file: string): void {
	try {
		fs.rmSync(file, { recursive: true, force: true });
	} catch {
		// Best effort cleanup for another process's stale lease.
	}
}

export class SessionCoordinator {
	readonly instanceId: string;
	readonly cwd: string;
	readonly root: string;
	#heartbeat: NodeJS.Timeout | undefined;
	#stopped = false;
	#speechLease = false;
	#pendingRelease: NodeJS.Timeout | undefined;
	#speechRequestEpoch = 0;
	#pendingPreemptionFile: string | undefined;
	#attentionEnabled = true;
	#outgoingAttention: string | undefined;
	#recovery: StopRecovery | undefined;

	get recovery(): StopRecovery {
		if (!this.#recovery) {
			const recovery = new StopRecovery(this.root, this.instanceId);
			recovery.initialize();
			this.#recovery = recovery;
		}
		return this.#recovery;
	}

	cancelSpeechAcquisition(): void {
		this.#speechRequestEpoch += 1;
		if (!this.#stopped) this.#writePresence();
		if (this.#outgoingAttention) remove(this.#outgoingAttention);
		this.#outgoingAttention = undefined;
		if (this.#pendingPreemptionFile) {
			if (readJson<{ requestedBy: string }>(this.#pendingPreemptionFile)?.requestedBy === this.instanceId) remove(this.#pendingPreemptionFile);
			this.#pendingPreemptionFile = undefined;
		}
	}

	setAttentionEnabled(enabled: boolean): void {
		this.#attentionEnabled = enabled;
		if (!enabled) {
			this.clearWaiting();
			this.consumeAttentionRequest();
		}
		if (!this.#stopped) this.#writePresence();
	}
	#resourceLeases = new Set<string>();

	readonly sessionId: string;

	constructor(cwd: string, sessionId: string, root = process.env.PI_VOICE_COORDINATOR_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "coordinator")) {
		this.sessionId = sessionId;
		this.cwd = path.resolve(cwd);
		this.root = path.resolve(root);
		const identity = createHash("sha256").update(`${process.pid}\0${sessionId}\0${this.cwd}\0${randomUUID()}`).digest("hex");
		this.instanceId = `${process.pid}-${identity.slice(0, 16)}`;
	}

	start(): void {
		void this.recovery; // Durable idle evidence precedes presence, ownership and admission.
		this.#stopped = false;
		fs.mkdirSync(this.#presenceDir(), { recursive: true });
		fs.mkdirSync(this.#waitingDir(), { recursive: true });
		fs.mkdirSync(this.#attentionDir(), { recursive: true });
		fs.mkdirSync(this.#preemptionDir(), { recursive: true });
		fs.mkdirSync(this.#resourceDir(), { recursive: true });
		this.#writePresence();
		this.#heartbeat = setInterval(() => {
			try {
				this.#writePresence();
				if (this.#speechLease) this.#refreshLease(this.#speechPath());
				for (const lease of this.#resourceLeases) this.#refreshLease(lease);
				this.#cleanStaleFiles();
			} catch (error) {
				console.error("Coordinator heartbeat failed; retaining speech fence", error);
			}
		}, HEARTBEAT_MS);
		this.#heartbeat.unref?.();
	}

	projectLabel(cwd = this.cwd, sessionId?: string, sessionName?: string): string {
		const target = path.resolve(cwd);
		const activePresences = this.activeSessions();
		const active = activePresences.map(session => path.resolve(session.cwd));
		if (!active.includes(target)) active.push(target);
		const targetParts = target.split(path.sep).filter(Boolean);
		let base: string | undefined;
		for (let depth = 1; depth <= targetParts.length; depth += 1) {
			const candidateLabel = targetParts.slice(-depth).join("/");
			const ambiguous = active.some(candidate => {
				if (candidate === target) return false;
				const parts = candidate.split(path.sep).filter(Boolean);
				return parts.slice(-depth).join("/") === candidateLabel;
			});
			if (!ambiguous) {
				base = candidateLabel;
				break;
			}
		}
		base ??= target;

		// Sessions sharing one directory stay distinguishable for humans via
		// their Pi session title plus a small number instead of hashes.
		const peers = activePresences
			.filter(presence => path.resolve(presence.cwd) === target)
				// Sort by the stable Pi session id so numbering survives restarts.
				.sort((left, right) => (left.sessionId ?? left.instanceId).localeCompare(right.sessionId ?? right.instanceId));
		if (peers.length <= 1) return base;
		const requestedSessionId = sessionId ?? this.sessionId;
		const number = peers.findIndex(presence => presence.sessionId === requestedSessionId) + 1
			|| peers.findIndex(presence => presence.instanceId === this.instanceId && target === this.cwd) + 1
			|| 1;
		const name = (sessionName ?? peers.find(presence => presence.sessionId === requestedSessionId)?.sessionName ?? "").trim();
		return name ? `${base} · ${name} ${number}` : `${base} ${number}`;
	}

	activeSessions(): SessionPresence[] {
		this.#cleanStaleFiles();
		return this.#jsonFiles<SessionPresence>(this.#presenceDir()).filter(session => this.#isLive(session));
	}

	tryAcquireSpeech(): boolean {
		if (this.#stopped) return false;
		if (this.ownsSpeech()) {
			return this.#reuseSpeechLease();
		}
		const lease = this.#acquireLease(this.#speechPath(), "speech");
		this.#speechLease = lease;
		return lease;
	}

	/** Manual user action requests an acknowledged handoff before taking the lease. */
	async forceAcquireSpeech(): Promise<boolean> {
		this.cancelSpeechAcquisition();
		const epoch = this.#speechRequestEpoch;
		const current = () => !this.#stopped && epoch === this.#speechRequestEpoch;
		if (!current()) return false;
		if (this.ownsSpeech()) {
			return this.#reuseSpeechLease();
		}
		const owner = this.speechOwner();
		if (owner) {
			const preemptionFile = this.#preemptionFile(owner.instanceId);
			this.#pendingPreemptionFile = preemptionFile;
			writeJson(preemptionFile, {
				requestedBy: this.instanceId,
				requestedAt: Date.now(),
				requestId: epoch,
			});
			// The owner may need the full acknowledged player-stop window before it
			// can release. Poll asynchronously so playback controls can supersede this
			// request while the TUI remains responsive.
			const deadline = Date.now() + SPEECH_HANDOFF_TIMEOUT_MS;
			while (current() && Date.now() < deadline && this.speechOwner()?.instanceId === owner.instanceId) {
				await new Promise(resolve => setTimeout(resolve, SPEECH_HANDOFF_POLL_MS));
			}
			const request = readJson<{ requestedBy: string; requestId: number }>(preemptionFile);
			if (request?.requestedBy === this.instanceId && request.requestId === epoch) remove(preemptionFile);
			if (current()) this.#pendingPreemptionFile = undefined;
		}
		if (!current()) return false;
		const remaining = this.speechOwner();
		if (remaining?.instanceId === this.instanceId) {
			return this.#reuseSpeechLease();
		}
		// A same-PID owner may still be stopping transports after session replacement.
		// Only its acknowledged release permits acquisition.
		if (remaining) return false;
		const lease = this.#acquireLease(this.#speechPath(), "speech");
		this.#speechLease = lease;
		return lease;
	}

	speechOwner(): SessionPresence | undefined {
		this.#removeStaleLease(this.#speechPath());
		const owner = readJson<Lease>(path.join(this.#speechPath(), "lease.json"));
		return owner?.kind === "speech" ? owner : undefined;
	}

	ownsSpeech(): boolean {
		return this.speechOwner()?.instanceId === this.instanceId;
	}

	#reuseSpeechLease(): boolean {
		// A previous publication may have linked successfully but failed fsync.
		const fd = fs.openSync(this.root, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		this.#cancelDeferredRelease();
		this.#speechLease = true;
		return true;
	}

	#cancelDeferredRelease(): void {
		if (this.#pendingRelease) clearTimeout(this.#pendingRelease);
		this.#pendingRelease = undefined;
	}

	releaseSpeech(): void {
		if (!this.#speechLease || this.#pendingRelease) return;
		const expected = readJson<Lease>(path.join(this.#speechPath(), "lease.json"));
		const release = (): void => {
			this.#pendingRelease = undefined;
			try {
				const released = this.#withSpeechMutation(false, () => {
					const owner = readJson<Lease>(path.join(this.#speechPath(), "lease.json"));
					if (owner?.kind === "speech" && owner.instanceId === this.instanceId &&
						owner.pid === expected?.pid && owner.speechGeneration === expected.speechGeneration) {
						fs.rmSync(this.#speechPath(), { recursive: true });
					}
					return true;
				});
				if (released) this.#speechLease = false;
				else this.#pendingRelease = setTimeout(release, SPEECH_HANDOFF_POLL_MS);
			} catch (error) {
				// Worker-event callers cannot catch asynchronous filesystem failures.
				console.error("Speech release failed; retrying", error);
				this.#pendingRelease = setTimeout(release, HEARTBEAT_MS);
			}
		};
		release();
	}

	/** Heartbeat expiry alone is never authority to stop somebody else's IO. */
	canRecoverSpeech(expected: SessionPresence): boolean {
		const owner = this.speechOwner();
		if (!expected.speechGeneration || owner?.instanceId !== expected.instanceId ||
			owner.speechGeneration !== expected.speechGeneration || owner.pid !== expected.pid ||
			!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
		try { process.kill(owner.pid, 0); return false; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	}

	/** Serialize orphan stop requests across sessions, without holding the speech mutation lock during IO. */
	async withSpeechRecovery(expected: SessionPresence, operation: () => Promise<void>): Promise<void> {
		const fd = fs.openSync(path.join(this.root, ".speech-recovery.lock"), "a", 0o600);
		try {
			if (process.platform !== "linux" && process.platform !== "android") return;
			const lock = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
			if (lock.status === 1) return;
			if (lock.error || lock.status !== 0) throw new Error("Speech recovery requires working Linux flock", { cause: lock.error });
			if (this.canRecoverSpeech(expected)) await operation();
		} finally { fs.closeSync(fd); }
	}

	/** No transport calls: dead authority + durable all-direction idle proof, including retired v3 output scopes. */
	recoverIdleSpeech(expected: SessionPresence): boolean {
		if (!expected.speechGeneration) return false;
		return this.#withSpeechMutation(false, () => {
			const file = path.join(this.#speechPath(), "lease.json");
			const owner = readJson<Lease>(file);
			if (owner?.kind !== "speech" || owner.instanceId !== expected.instanceId ||
				owner.speechGeneration !== expected.speechGeneration || owner.pid !== expected.pid ||
				!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
			try { process.kill(owner.pid, 0); return false; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
			try {
				const recovery = new StopRecovery(this.root, owner.instanceId);
				if (!recovery.isIdle("input") || !recovery.isIdle("output")) return false;
			} catch { return false; }
			fs.rmSync(this.#speechPath(), { recursive: true });
			return true;
		});
	}

	#withSpeechMutation<T>(busy: T, operation: () => T): T {
		// Linux flock locks the inherited open file description, not the helper PID.
		// Never unlink this inode: independent opens must always contend on the same lock.
		const lock = path.join(this.root, ".speech-mutation.lock");
		const fd = fs.openSync(lock, "a", 0o600);
		try {
			if (process.platform !== "linux" && process.platform !== "android") throw new Error("Speech coordination requires Linux flock");
			const result = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
			if (result.status === 1) return busy;
			if (result.error || result.status !== 0) throw new Error("Speech coordination requires working Linux flock", { cause: result.error });
			const value = operation();
			if (value === true) {
				const directory = fs.openSync(this.root, "r");
				try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
			}
			return value;
		} finally { fs.closeSync(fd); }
	}

	attentionIsCurrent(): boolean {
		const current = readJson<SessionPresence>(this.#attentionCurrentFile());
		if (current?.instanceId !== this.instanceId) return false;
		const presence = readJson<SessionPresence>(this.#presenceFile(this.instanceId));
		return Boolean(presence && this.#isLive(presence));
	}

	/** Records that this session actually began user-audible project speech. */
	claimAttention(): boolean {
		const changed = !this.attentionIsCurrent();
		writeJson(this.#attentionCurrentFile(), this.#presence());
		return changed;
	}

	markWaiting(connection?: ConnectionDevice): WaitingSession {
		return this.#withWaitingMutation(() => {
			const file = this.#waitingFile(this.instanceId);
			const existing = readJson<WaitingSession>(file);
			const waiting: WaitingSession = {
				...this.#presence(),
				generation: existing?.generation ?? randomUUID(),
				waitingSince: existing?.waitingSince ?? Date.now(),
				announced: existing?.announced ?? false,
				connection: existing ? existing.connection : connection,
			};
			if (!this.#stopped && this.#attentionEnabled) writeJson(file, waiting);
			return waiting;
		});
	}

	clearWaiting(): void {
		if (!fs.existsSync(this.root)) return;
		this.#withWaitingMutation(() => remove(this.#waitingFile(this.instanceId)));
	}

	#withWaitingMutation<T>(operation: () => T): T {
		void this.recovery;
		// One inode serializes mark, clear, cleanup and ACK across processes.
		const fd = fs.openSync(path.join(this.root, ".waiting-mutation.lock"), "a", 0o600);
		try {
			if (process.platform !== "linux" && process.platform !== "android") throw new Error("Waiting coordination requires Linux flock");
			const lock = spawnSync("flock", ["3"], { stdio: ["ignore", "ignore", "pipe", fd] });
			if (lock.error || lock.status !== 0) throw new Error("Waiting coordination requires working Linux flock", { cause: lock.error });
			return operation();
		} finally { fs.closeSync(fd); }
	}

	#waitingPresence(waiting: WaitingSession): SessionPresence | undefined {
		const live = readJson<SessionPresence>(this.#presenceFile(waiting.instanceId));
		return live && live.instanceId === waiting.instanceId && live.pid === waiting.pid &&
			live.cwd === waiting.cwd && live.sessionId === waiting.sessionId && live.attentionEnabled !== false &&
			this.#isLive(live) ? live : undefined;
	}

	isWaiting(instanceId = this.instanceId): boolean {
		return this.waitingSessions().some(waiting => waiting.instanceId === instanceId);
	}

	waitingSessions(): WaitingSession[] {
		this.#cleanStaleFiles();
		return this.#jsonFiles<WaitingSession>(this.#waitingDir())
			.flatMap(waiting => {
				const live = this.#waitingPresence(waiting);
				return live ? [{ ...waiting, ...live }] : [];
			})
			.sort((left, right) => left.waitingSince - right.waitingSince || left.instanceId.localeCompare(right.instanceId));
	}

	nextUnannouncedWaiting(connection?: ConnectionDevice): WaitingSession | undefined {
		const outgoing = this.#outgoingAttention && readJson<AttentionRequest>(this.#outgoingAttention);
		if (outgoing && Date.now() - outgoing.requestedAt < STALE_MS) return;
		return this.waitingSessions().find(waiting => waiting.instanceId !== this.instanceId && !waiting.announced &&
			Boolean(waiting.generation) && (connection?.kind === "intentional_local"
				? waiting.connection?.kind === "intentional_local"
				: connection?.kind === "device" && /^[a-zA-Z0-9._-]{1,128}$/.test(connection.id) &&
					waiting.connection?.kind === "device" && waiting.connection.id === connection.id));
	}

	/** Claims the free speech channel to announce another project's wait. */
	tryAcquireWaitingAnnouncement(connection?: ConnectionDevice): WaitingSession | undefined {
		const waiting = this.nextUnannouncedWaiting(connection);
		if (!waiting || !this.tryAcquireSpeech()) return undefined;
		return waiting;
	}

	/** Unscoped legacy callers compile during integration but cannot acknowledge delivery. */
	markAnnounced(expected: WaitingSession | string, generation?: string): boolean {
		const instanceId = typeof expected === "string" ? expected : expected.instanceId;
		generation = typeof expected === "string" ? generation : expected.generation;
		if (!generation) return false;
		return this.#withWaitingMutation(() => {
			const file = this.#waitingFile(instanceId);
			const waiting = readJson<WaitingSession>(file);
			if (!waiting || waiting.generation !== generation || !this.#waitingPresence(waiting)) return false;
			writeJson(file, { ...waiting, announced: true });
			return true;
		});
	}

	requestAttention(instanceId: string, connection?: AttentionRequest["connection"]): void {
		this.cancelSpeechAcquisition();
		const waiting = this.waitingSessions().find(session => session.instanceId === instanceId);
		if (this.#stopped || !waiting) return;
		const request: AttentionRequest = { requestedAt: Date.now(), requestedBy: this.instanceId, requestId: randomUUID(), receiverEpoch: readJson<SessionPresence>(this.#presenceFile(instanceId))?.attentionEpoch ?? 0, connection };
		this.#outgoingAttention = path.join(this.root, `attention-request-${this.instanceId}.json`);
		writeJson(this.#outgoingAttention, request);
		writeJson(this.#attentionFile(instanceId), request);
	}

	attentionRequestIsCurrent(request: AttentionRequest): boolean {
		const sender = this.activeSessions().find(session => session.instanceId === request.requestedBy);
		const age = Date.now() - request.requestedAt;
		const newer = readJson<AttentionRequest>(this.#attentionFile(this.instanceId));
		return !!sender && Number.isFinite(request.requestedAt) && age >= 0 && age < STALE_MS &&
			(!newer || newer.requestId === request.requestId) &&
			readJson<AttentionRequest>(path.join(this.root, `attention-request-${sender.instanceId}.json`))?.requestId === request.requestId;
	}

	takeAttentionRequest(): AttentionRequest | undefined {
		const file = this.#takeAttentionFile();
		if (!file) return;
		const request = readJson<AttentionRequest>(file);
		remove(file);
		if (!request || (request.receiverEpoch ?? 0) !== this.#speechRequestEpoch || !this.#attentionEnabled || !this.isWaiting() || !this.attentionRequestIsCurrent(request)) return;
		const connection = request.connection;
		if (connection && connection.kind !== "intentional_local" &&
			(connection.kind !== "device" || typeof connection.id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(connection.id))) return;
		return request;
	}

	hasAttentionRequest(): boolean {
		return fs.existsSync(this.#attentionFile(this.instanceId));
	}

	#takeAttentionFile(): string | undefined {
		const file = this.#attentionFile(this.instanceId);
		const claimed = `${file}.${randomUUID()}.claimed`;
		try {
			fs.renameSync(file, claimed);
			return claimed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	consumeAttentionRequest(): boolean {
		const file = this.#takeAttentionFile();
		if (!file) return false;
		remove(file);
		return true;
	}

	consumeSpeechPreemptionRequest(): boolean {
		const file = this.#preemptionFile(this.instanceId);
		if (!fs.existsSync(file)) return false;
		remove(file);
		return true;
	}

	async withResource<T>(kind: "code" | "timing", limit: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		let lease: string | undefined;
		while (!lease) {
			signal?.throwIfAborted();
			if (this.#stopped) return operation();
			for (let index = 0; index < Math.max(1, limit); index += 1) {
				const candidate = path.join(this.#resourceDir(), `${kind}-${index}.lock`);
				if (this.#acquireLease(candidate, kind)) {
					lease = candidate;
					this.#resourceLeases.add(candidate);
					break;
				}
			}
			if (!lease) await delay(100, undefined, { signal });
		}
		try {
			return await operation();
		} finally {
			this.#resourceLeases.delete(lease);
			this.#releaseLease(lease);
		}
	}

	/** Defer while transports stop; retry without deferral only after stop is confirmed. */
	shutdown(deferRelease = false): void {
		this.#stopped = true;
		this.cancelSpeechAcquisition();
		// Keep presence and leases live until the transports acknowledge shutdown.
		if (deferRelease) return;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		this.releaseSpeech();
		for (const lease of this.#resourceLeases) this.#releaseLease(lease);
		this.#resourceLeases.clear();
		this.clearWaiting();
		remove(this.#attentionFile(this.instanceId));
		remove(this.#preemptionFile(this.instanceId));
		remove(this.#presenceFile(this.instanceId));
	}

	#sessionName: string | undefined;

	setSessionName(name: string | undefined): void {
		const trimmed = name?.trim() || undefined;
		if (trimmed === this.#sessionName) return;
		this.#sessionName = trimmed;
		if (!this.#stopped) this.#writePresence();
	}

	#presence(): SessionPresence {
		return {
			interactive: true,
			instanceId: this.instanceId,
			pid: process.pid,
			cwd: this.cwd,
			updatedAt: Date.now(),
			sessionId: this.sessionId,
			attentionEnabled: this.#attentionEnabled,
			attentionEpoch: this.#speechRequestEpoch,
			...(this.#sessionName ? { sessionName: this.#sessionName } : {}),
		};
	}

	#writePresence(): void {
		void this.recovery; // Pre-start setters must not create the root before durable initialization.
		writeJson(this.#presenceFile(this.instanceId), this.#presence());
	}

	#acquireLease(directory: string, kind: string): boolean {
		if (kind === "speech") {
			void this.recovery;
			return this.#withSpeechMutation(false, () => {
				if (fs.existsSync(directory)) return false;
				const temporary = fs.mkdtempSync(`${directory}.`);
				let published = false;
				try {
					writeJson(path.join(temporary, "lease.json"), { ...this.#presence(), kind, speechGeneration: randomUUID() }, true);
					// Native atomic no-clobber publication, including empty legacy directories.
					try { fs.symlinkSync(path.basename(temporary), directory, "dir"); }
					catch (error) {
						if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
						throw error;
					}
					published = true;
					this.#cancelDeferredRelease();
					return true;
				} finally {
					// ponytail: retain named backing directories as audit data; add offline pruning if disk growth matters.
					// Legacy recursive removal unlinks only speech.lock, never its populated backing directory.
					if (!published) remove(temporary);
				}
			});
		}
		return this.#createLease(directory, kind);
	}

	#createLease(directory: string, kind: string): boolean {
		this.#removeStaleLease(directory);
		try {
			fs.mkdirSync(directory);
			writeJson(path.join(directory, "lease.json"), { ...this.#presence(), kind });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			remove(directory);
			return false;
		}
	}

	#releaseLease(directory: string): void {
		const lease = readJson<Lease>(path.join(directory, "lease.json"));
		if (lease?.instanceId === this.instanceId) remove(directory);
	}

	#refreshLease(directory: string): void {
		if (directory === this.#speechPath()) {
			this.#withSpeechMutation(undefined, () => this.#writeLeaseHeartbeat(directory));
		} else this.#writeLeaseHeartbeat(directory);
	}

	#writeLeaseHeartbeat(directory: string): void {
		const file = path.join(directory, "lease.json");
		const lease = readJson<Lease>(file);
		if (lease?.instanceId === this.instanceId) writeJson(file, { ...lease, updatedAt: Date.now() }, directory === this.#speechPath());
	}

	#removeStaleLease(directory: string): void {
		// Even missing/malformed speech metadata is uncertainty, not abandoned ownership proof.
		if (directory === this.#speechPath() || !fs.existsSync(directory)) return;
		const lease = readJson<Lease>(path.join(directory, "lease.json"));
		// Process death/heartbeat expiry cannot prove a remote player or recorder stopped.
		// Keep the durable speech fence; only the owning cleanup may release it.
		if (lease && (lease.kind === "speech" || this.#isLive(lease))) return;
		try {
			const age = Date.now() - fs.statSync(directory).mtimeMs;
			if (!lease && age < 2_000) return;
		} catch {
			return;
		}
		remove(directory);
	}

	#cleanStaleFiles(): void {
		this.#removeStaleLease(this.#speechPath());
		for (const item of this.#jsonFiles<SessionPresence>(this.#presenceDir())) {
			if (!this.#isLive(item)) remove(this.#presenceFile(item.instanceId));
		}
		const stale = this.#jsonFiles<WaitingSession>(this.#waitingDir()).filter(waiting => !this.#waitingPresence(waiting));
		if (stale.length) this.#withWaitingMutation(() => {
			for (const candidate of stale) {
				const waiting = readJson<WaitingSession>(this.#waitingFile(candidate.instanceId));
				if (waiting && !this.#waitingPresence(waiting)) remove(this.#waitingFile(candidate.instanceId));
			}
		});
		try {
			for (const name of fs.readdirSync(this.#resourceDir())) {
				if (name.endsWith(".lock")) this.#removeStaleLease(path.join(this.#resourceDir(), name));
			}
		} catch {
			// Directory may not exist during shutdown.
		}
	}

	#isLive(session: SessionPresence): boolean {
		return session.interactive === true && Date.now() - session.updatedAt <= STALE_MS && processIsAlive(session.pid);
	}

	#jsonFiles<T>(directory: string): T[] {
		try {
			return fs
				.readdirSync(directory)
				.filter(name => name.endsWith(".json"))
				.map(name => readJson<T>(path.join(directory, name)))
				.filter((value): value is T => value !== undefined);
		} catch {
			return [];
		}
	}

	#presenceDir(): string {
		return path.join(this.root, "sessions");
	}

	#waitingDir(): string {
		return path.join(this.root, "waiting");
	}

	#attentionDir(): string {
		return path.join(this.root, "attention");
	}

	#preemptionDir(): string {
		return path.join(this.root, "preemption");
	}

	#resourceDir(): string {
		return path.join(this.root, "resources");
	}

	#speechPath(): string {
		return path.join(this.root, "speech.lock");
	}

	#presenceFile(instanceId: string): string {
		return path.join(this.#presenceDir(), `${instanceId}.json`);
	}

	#waitingFile(instanceId: string): string {
		return path.join(this.#waitingDir(), `${instanceId}.json`);
	}

	#attentionFile(instanceId: string): string {
		return path.join(this.#attentionDir(), `${instanceId}.json`);
	}

	#preemptionFile(instanceId: string): string {
		return path.join(this.#preemptionDir(), `${instanceId}.json`);
	}

	#attentionCurrentFile(): string {
		return path.join(this.root, "attention-current.json");
	}
}
