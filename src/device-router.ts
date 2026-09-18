import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceRoutingError, resolveCurrentConnection, type ConnectionDevice } from "./connection-device.js";

export { DeviceRoutingError, resolveCurrentConnection } from "./connection-device.js";
export type { ConnectionDevice } from "./connection-device.js";

export type DeviceDirection = "input" | "output";
/** Routing decision only; `device` does not mean connected or transport-ready. */
export type DeviceRoute =
	| { kind: "device"; endpoint: string; device: VoiceDeviceRegistration }
	| { kind: "intentional_local"; endpoint: "local" }
	| { kind: "disabled"; endpoint: "disabled" }
	| { kind: "custom"; endpoint: string };

/** Format validation only: even an accepted SSH reverse connection proves no client readiness. */
function validDeviceEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.username || url.password || url.search || url.hash) return false;
		if (url.protocol === "unix:") {
			const socket = decodeURIComponent(url.pathname);
			return !url.host && socket.startsWith("/") && socket.length > 1 && !socket.includes("\0");
		}
		return url.protocol === "tcp:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
			&& Number(url.port) > 0 && Number(url.port) <= 65535 && !url.pathname;
	} catch { return false; }
}

export interface VoiceDeviceRegistration {
	version: 1;
	id: string;
	name: string;
	platform: "linux" | "termux";
	audioEndpoint: string;
	inputEndpoint: string;
	connectedAt: number;
	lastActive: number;
}

export type VoiceDeviceSelection = "auto" | "local" | string;

function readRegistration(file: string): VoiceDeviceRegistration | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as VoiceDeviceRegistration;
		if (
			value.version !== 1 ||
			typeof value.id !== "string" ||
			!/^[a-zA-Z0-9._-]{1,128}$/.test(value.id) ||
			typeof value.name !== "string" ||
			(value.platform !== "linux" && value.platform !== "termux") ||
			typeof value.audioEndpoint !== "string" ||
			typeof value.inputEndpoint !== "string" ||
			!Number.isFinite(value.connectedAt) ||
			!Number.isFinite(value.lastActive)
		) {
			return undefined;
		}
		return value;
	} catch {
		return undefined;
	}
}

function loopbackPortIsListening(port: number): boolean | undefined {
	let readable = false;
	const expected = port.toString(16).toUpperCase().padStart(4, "0");
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		try {
			const contents = fs.readFileSync(table, "utf8");
			readable = true;
			for (const line of contents.split("\n").slice(1)) {
				const columns = line.trim().split(/\s+/);
				if (columns.length < 4 || columns[3] !== "0A") continue;
				const [address, candidatePort] = columns[1].split(":");
				if (candidatePort !== expected) continue;
				if (address === "0100007F" || address === "00000000000000000000000001000000") return true;
			}
		} catch {
			// procfs is unavailable on some platforms.
		}
	}
	return readable ? false : undefined;
}

function endpointIsAvailable(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.protocol === "unix:") return fs.existsSync(decodeURIComponent(url.pathname));
		if (url.protocol === "tcp:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]")) {
			// Android and restricted hosts may hide procfs; let the transport
			// attempt the connection rather than silently hiding every device.
			return loopbackPortIsListening(Number(url.port)) ?? true;
		}
		return true;
	} catch {
		return false;
	}
}

export class DeviceRouter {
	readonly directory: string;
	#environmentDeviceId: string | undefined;

	constructor(
		directory = process.env.PI_VOICE_DEVICE_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "devices"),
		environmentDeviceId = process.env.PI_VOICE_DEVICE_ID,
		private readonly context: NodeJS.ProcessEnv = process.env,
	) {
		this.directory = directory;
		this.#environmentDeviceId = environmentDeviceId;
	}

	/** Best-effort menu candidates only. Neither procfs nor route() proves client connectivity. */
	connected(): VoiceDeviceRegistration[] {
		let names: string[] = [];
		try {
			names = fs.readdirSync(this.directory);
		} catch {
			// A legacy TCP bridge may still be connected without a registry directory.
		}
		const devices = names
			.filter(name => name.endsWith(".json"))
			.map(name => readRegistration(path.join(this.directory, name)))
			.filter((device): device is VoiceDeviceRegistration => device !== undefined)
			.filter(device => endpointIsAvailable(device.audioEndpoint) || endpointIsAvailable(device.inputEndpoint))
			.sort((left, right) => right.lastActive - left.lastActive || right.connectedAt - left.connectedAt);
		if (devices.length === 0) {
			const audioPort = Number(process.env.PI_VOICE_AUDIO_PORT ?? 8765);
			const inputPort = Number(process.env.PI_VOICE_CONTROL_PORT ?? 8766);
			if (loopbackPortIsListening(audioPort) || loopbackPortIsListening(inputPort)) {
				devices.push(this.legacyDevice());
			}
		}
		return devices;
	}

	/** Metadata lookup only for pinned IDs: no registry enumeration or procfs scans.
	 * Auto without a pin is local only outside SSH/tmux. No device discovery or connectivity claim.
	 */
	resolve(selection: VoiceDeviceSelection): VoiceDeviceRegistration | undefined {
		if (selection === "local") return undefined;
		const id = selection === "auto" ? this.#environmentDeviceId : selection;
		if (id) {
			if (id === "legacy-loopback") return this.legacyDevice();
			const device = /^[a-zA-Z0-9._-]{1,128}$/.test(id)
				? readRegistration(path.join(this.directory, `${id}.json`)) : undefined;
			if (!device || device.id !== id) throw new DeviceRoutingError("device_unavailable", `Voice device ${id} is unavailable; reconnect and retry.`);
			return device;
		}
		if (this.context.SSH_CONNECTION || this.context.SSH_CLIENT || this.context.SSH_TTY || this.context.TMUX || this.context.PI_VOICE_DEVICE_TARGET) {
			throw new DeviceRoutingError("missing_identity", "No voice device is pinned for this connection; resolve and adopt the current connection identity first.");
		}
		return undefined;
	}

	/** Fresh identity for explicit reconnect/playback. Does not change or persist a pin. */
	resolveCurrentConnection(env: NodeJS.ProcessEnv = process.env): Promise<ConnectionDevice> {
		return resolveCurrentConnection(env);
	}

	/** Return pinned endpoint metadata, NOT a validated connection. Never opens a socket.
	 * Caller must await actual transport readiness and surface errors without fallback.
	 * Local/disabled/custom config intentionally bypasses device lookup.
	 */
	async route(
		selection: VoiceDeviceSelection,
		direction: DeviceDirection,
		configured = "auto",
	): Promise<DeviceRoute> {
		return this.routeMetadata(selection, direction, configured);
	}

	/** Same metadata decision for synchronous worker configuration callbacks. No transport I/O. */
	routeMetadata(selection: VoiceDeviceSelection, direction: DeviceDirection, configured = "auto"): DeviceRoute {
		if (configured === "disabled") return { kind: "disabled", endpoint: "disabled" };
		if (configured === "local" || (configured === "auto" && selection === "local")) return { kind: "intentional_local", endpoint: "local" };
		if (configured !== "auto") return { kind: "custom", endpoint: configured };
		const device = this.resolve(selection);
		if (!device) return { kind: "intentional_local", endpoint: "local" };
		const endpoint = direction === "input" ? device.inputEndpoint : device.audioEndpoint;
		if (!validDeviceEndpoint(endpoint)) throw new DeviceRoutingError("device_unavailable", `Voice device ${device.id} has an invalid ${direction} endpoint; reconnect and retry.`);
		return { kind: "device", endpoint, device };
	}

	claim(selection: VoiceDeviceSelection): VoiceDeviceRegistration | undefined {
		const device = this.resolve(selection);
		if (!device) return undefined;
		const file = path.join(this.directory, `${device.id}.json`);
		const updated = { ...device, lastActive: Date.now() };
		const temporary = `${file}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(temporary, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
			fs.renameSync(temporary, file);
		} catch {
			try {
				fs.rmSync(temporary, { force: true });
			} catch {
				// Best effort.
			}
		}
		return updated;
	}

	private legacyDevice(): VoiceDeviceRegistration {
		return {
			version: 1, id: "legacy-loopback", name: "Legacy SSH client", platform: "termux",
			audioEndpoint: `tcp://127.0.0.1:${process.env.PI_VOICE_AUDIO_PORT ?? 8765}`,
			inputEndpoint: `tcp://127.0.0.1:${process.env.PI_VOICE_CONTROL_PORT ?? 8766}`,
			connectedAt: 0, lastActive: 0,
		};
	}

	/** Adopt a caller-verified identity/pin; this does not connect or restart a client. */
	setEnvironmentDevice(id: string | undefined): void {
		this.#environmentDeviceId = id;
	}
}
