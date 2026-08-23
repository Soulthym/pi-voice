import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionPresence {
	interactive: true;
	instanceId: string;
	pid: number;
	cwd: string;
	updatedAt: number;
}

export interface WaitingSession extends SessionPresence {
	waitingSince: number;
	announced: boolean;
}

type Lease = SessionPresence & { kind: string };

const HEARTBEAT_MS = 1_000;
const STALE_MS = 8_000;

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

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
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
	#resourceLeases = new Set<string>();

	constructor(cwd: string, sessionId: string, root = process.env.PI_VOICE_COORDINATOR_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "coordinator")) {
		this.cwd = path.resolve(cwd);
		this.root = root;
		const identity = createHash("sha256").update(`${process.pid}\0${sessionId}\0${this.cwd}\0${randomUUID()}`).digest("hex");
		this.instanceId = `${process.pid}-${identity.slice(0, 16)}`;
	}

	start(): void {
		this.#stopped = false;
		fs.mkdirSync(this.#presenceDir(), { recursive: true });
		fs.mkdirSync(this.#waitingDir(), { recursive: true });
		fs.mkdirSync(this.#attentionDir(), { recursive: true });
		fs.mkdirSync(this.#resourceDir(), { recursive: true });
		this.#writePresence();
		this.#heartbeat = setInterval(() => {
			this.#writePresence();
			if (this.#speechLease) this.#refreshLease(this.#speechPath());
			for (const lease of this.#resourceLeases) this.#refreshLease(lease);
			this.#cleanStaleFiles();
		}, HEARTBEAT_MS);
		this.#heartbeat.unref?.();
	}

	projectLabel(cwd = this.cwd): string {
		const target = path.resolve(cwd);
		const active = this.activeSessions().map(session => path.resolve(session.cwd));
		if (!active.includes(target)) active.push(target);
		const targetParts = target.split(path.sep).filter(Boolean);
		for (let depth = 1; depth <= targetParts.length; depth += 1) {
			const label = targetParts.slice(-depth).join("/");
			const ambiguous = active.some(candidate => {
				if (candidate === target) return false;
				const parts = candidate.split(path.sep).filter(Boolean);
				return parts.slice(-depth).join("/") === label;
			});
			if (!ambiguous) return label;
		}
		return target;
	}

	activeSessions(): SessionPresence[] {
		this.#cleanStaleFiles();
		return this.#jsonFiles<SessionPresence>(this.#presenceDir()).filter(session => this.#isLive(session));
	}

	tryAcquireSpeech(): boolean {
		if (this.ownsSpeech()) {
			this.#speechLease = true;
			return true;
		}
		const lease = this.#acquireLease(this.#speechPath(), "speech");
		this.#speechLease = lease;
		return lease;
	}

	/** Manual user action preempts the current lease instead of waiting behind it. */
	forceAcquireSpeech(): boolean {
		if (this.ownsSpeech()) {
			this.#speechLease = true;
			return true;
		}
		remove(this.#speechPath());
		const lease = this.#acquireLease(this.#speechPath(), "speech");
		this.#speechLease = lease;
		return lease;
	}

	speechOwner(): SessionPresence | undefined {
		this.#removeStaleLease(this.#speechPath());
		const owner = readJson<Lease>(path.join(this.#speechPath(), "lease.json"));
		return owner && this.#isLive(owner) ? owner : undefined;
	}

	ownsSpeech(): boolean {
		return this.speechOwner()?.instanceId === this.instanceId;
	}

	releaseSpeech(): void {
		if (!this.#speechLease) return;
		this.#releaseLease(this.#speechPath());
		this.#speechLease = false;
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

	markWaiting(): WaitingSession {
		const file = this.#waitingFile(this.instanceId);
		const existing = readJson<WaitingSession>(file);
		const waiting: WaitingSession = {
			...this.#presence(),
			waitingSince: existing?.waitingSince ?? Date.now(),
			announced: existing?.announced ?? false,
		};
		writeJson(file, waiting);
		return waiting;
	}

	clearWaiting(): void {
		remove(this.#waitingFile(this.instanceId));
	}

	isWaiting(instanceId = this.instanceId): boolean {
		return this.waitingSessions().some(waiting => waiting.instanceId === instanceId);
	}

	waitingSessions(): WaitingSession[] {
		this.#cleanStaleFiles();
		return this.#jsonFiles<WaitingSession>(this.#waitingDir())
			.filter(waiting => this.#isLive(waiting))
			.sort((left, right) => left.waitingSince - right.waitingSince || left.instanceId.localeCompare(right.instanceId));
	}

	nextUnannouncedWaiting(): WaitingSession | undefined {
		return this.waitingSessions().find(waiting => !waiting.announced);
	}

	markAnnounced(instanceId: string): void {
		const file = this.#waitingFile(instanceId);
		const waiting = readJson<WaitingSession>(file);
		if (waiting) writeJson(file, { ...waiting, announced: true, updatedAt: Date.now() });
	}

	requestAttention(instanceId: string): void {
		const waiting = this.waitingSessions().find(session => session.instanceId === instanceId);
		if (!waiting) return;
		writeJson(this.#attentionFile(instanceId), { requestedAt: Date.now(), requestedBy: this.instanceId });
	}

	hasAttentionRequest(): boolean {
		return fs.existsSync(this.#attentionFile(this.instanceId));
	}

	consumeAttentionRequest(): boolean {
		const file = this.#attentionFile(this.instanceId);
		if (!fs.existsSync(file)) return false;
		remove(file);
		return true;
	}

	async withResource<T>(kind: "code" | "timing", limit: number, operation: () => Promise<T>): Promise<T> {
		let lease: string | undefined;
		while (!lease) {
			if (this.#stopped) return operation();
			for (let index = 0; index < Math.max(1, limit); index += 1) {
				const candidate = path.join(this.#resourceDir(), `${kind}-${index}.lock`);
				if (this.#acquireLease(candidate, kind)) {
					lease = candidate;
					this.#resourceLeases.add(candidate);
					break;
				}
			}
			if (!lease) await new Promise(resolve => setTimeout(resolve, 100));
		}
		try {
			return await operation();
		} finally {
			this.#resourceLeases.delete(lease);
			this.#releaseLease(lease);
		}
	}

	shutdown(): void {
		this.#stopped = true;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		this.releaseSpeech();
		for (const lease of this.#resourceLeases) this.#releaseLease(lease);
		this.#resourceLeases.clear();
		this.clearWaiting();
		remove(this.#attentionFile(this.instanceId));
		remove(this.#presenceFile(this.instanceId));
	}

	#presence(): SessionPresence {
		return { interactive: true, instanceId: this.instanceId, pid: process.pid, cwd: this.cwd, updatedAt: Date.now() };
	}

	#writePresence(): void {
		writeJson(this.#presenceFile(this.instanceId), this.#presence());
	}

	#acquireLease(directory: string, kind: string): boolean {
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
		const file = path.join(directory, "lease.json");
		const lease = readJson<Lease>(file);
		if (lease?.instanceId === this.instanceId) writeJson(file, { ...lease, updatedAt: Date.now() });
	}

	#removeStaleLease(directory: string): void {
		if (!fs.existsSync(directory)) return;
		const lease = readJson<Lease>(path.join(directory, "lease.json"));
		if (lease && this.#isLive(lease)) return;
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
		for (const directory of [this.#presenceDir(), this.#waitingDir()]) {
			for (const item of this.#jsonFiles<SessionPresence>(directory)) {
				if (!this.#isLive(item)) remove(path.join(directory, `${item.instanceId}.json`));
			}
		}
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

	#attentionCurrentFile(): string {
		return path.join(this.root, "attention-current.json");
	}
}
