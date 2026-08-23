import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function loopbackPortIsListening(port: number): boolean {
	const expected = port.toString(16).toUpperCase().padStart(4, "0");
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		try {
			for (const line of fs.readFileSync(table, "utf8").split("\n").slice(1)) {
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
	return false;
}

function endpointSocket(endpoint: string): string | undefined {
	try {
		const url = new URL(endpoint);
		return url.protocol === "unix:" ? decodeURIComponent(url.pathname) : undefined;
	} catch {
		return undefined;
	}
}

export class DeviceRouter {
	readonly directory: string;
	#environmentDeviceId: string | undefined;

	constructor(
		directory = process.env.PI_VOICE_DEVICE_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "devices"),
		environmentDeviceId = process.env.PI_VOICE_DEVICE_ID,
	) {
		this.directory = directory;
		this.#environmentDeviceId = environmentDeviceId;
	}

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
			.filter(device => {
				const audio = endpointSocket(device.audioEndpoint);
				const input = endpointSocket(device.inputEndpoint);
				return (!audio || fs.existsSync(audio)) && (!input || fs.existsSync(input));
			})
			.sort((left, right) => right.lastActive - left.lastActive || right.connectedAt - left.connectedAt);
		if (devices.length === 0) {
			const audioPort = Number(process.env.PI_VOICE_AUDIO_PORT ?? 8765);
			const inputPort = Number(process.env.PI_VOICE_CONTROL_PORT ?? 8766);
			if (loopbackPortIsListening(audioPort) && loopbackPortIsListening(inputPort)) {
				devices.push({
					version: 1,
					id: "legacy-loopback",
					name: "Legacy SSH client",
					platform: "termux",
					audioEndpoint: `tcp://127.0.0.1:${audioPort}`,
					inputEndpoint: `tcp://127.0.0.1:${inputPort}`,
					connectedAt: 0,
					lastActive: 0,
				});
			}
		}
		return devices;
	}

	resolve(selection: VoiceDeviceSelection): VoiceDeviceRegistration | undefined {
		const connected = this.connected();
		if (selection === "local") return undefined;
		if (selection !== "auto") return connected.find(device => device.id === selection);
		if (this.#environmentDeviceId) {
			const inherited = connected.find(device => device.id === this.#environmentDeviceId);
			if (inherited) return inherited;
		}
		return connected[0];
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

	setEnvironmentDevice(id: string | undefined): void {
		this.#environmentDeviceId = id;
	}
}
