import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export class DeviceRoutingError extends Error {
	constructor(readonly code: "attachment_unavailable" | "ambiguous_attachment" | "missing_identity" | "attachment_changed" | "device_unavailable" | "ambiguous_device", message: string) {
		super(message);
		this.name = "DeviceRoutingError";
	}
}

export type ConnectionDevice = { kind: "device"; id: string; target?: string } | { kind: "intentional_local" };

const execute = promisify(execFile);
const systemIO = {
	tmux: async (args: string[]) => (await execute("tmux", args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout,
	read: (file: string) => readFile(file, "utf8"),
};

function identity(env: NodeJS.ProcessEnv, attached: boolean): ConnectionDevice {
	const id = env.PI_VOICE_DEVICE_ID;
	const target = env.PI_VOICE_DEVICE_TARGET;
	if (!id && !attached && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY && !target) return { kind: "intentional_local" };
	if (!id || !/^[a-zA-Z0-9._-]{1,128}$/.test(id) || (attached && !target) || (target !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(target))) {
		throw new DeviceRoutingError("missing_identity", "The current connection has no valid voice device identity; reconnect using the voice SSH wrapper.");
	}
	return { kind: "device", id, ...(target ? { target } : {}) };
}

/** Read only identity/context keys; never expose the client's other environment values. */
function clientEnvironment(raw: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const entry of raw.split("\0")) {
		const separator = entry.indexOf("=");
		const key = entry.slice(0, separator);
		if (!["PI_VOICE_DEVICE_ID", "PI_VOICE_DEVICE_TARGET", "TMUX"].includes(key)) continue;
		if (Object.hasOwn(env, key)) throw new DeviceRoutingError("missing_identity", "Duplicate connection identity.");
		env[key] = entry.slice(separator + 1);
	}
	return env;
}

function processStart(stat: string): string {
	// comm may contain spaces and parentheses; starttime is field 22.
	const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
	if (!start || !/^\d+$/.test(start)) throw new Error("Invalid process identity");
	return start;
}

/** Fresh attachment only. Does not mutate the router pin; callers persist/adopt after success. */
export async function resolveCurrentConnection(
	env: NodeJS.ProcessEnv = process.env,
	io = systemIO,
): Promise<ConnectionDevice> {
	if (!env.TMUX) return identity(env, false);
	const match = /^(.*),(\d+),(\d+)$/.exec(env.TMUX);
	if (!match || !match[1].startsWith("/") || !/^%\d+$/.test(env.TMUX_PANE ?? "")) {
		throw new DeviceRoutingError("attachment_unavailable", "Cannot identify this tmux socket and pane.");
	}
	const socket = match[1];
	const pane = env.TMUX_PANE!;
	const tmux = (args: string[]) => io.tmux(["-S", socket, ...args]);
	const snapshot = async () => {
		// A pane's window can be linked into several sessions. Inspect every membership,
		// not only the session selected by tmux's default target heuristics.
		const memberships = (await tmux(["list-panes", "-a", "-F", "#{session_id}\t#{pane_id}"])).trim().split("\n")
			.filter(line => line.split("\t")[1] === pane).map(line => line.split("\t")[0]);
		if (!memberships.length) throw new DeviceRoutingError("attachment_unavailable", "The tmux pane is no longer attached to a session.");
		const clients = (await tmux(["list-clients", "-F", "#{session_id}\t#{client_pid}\t#{client_created}\t#{client_tty}"])).trim().split("\n")
			.filter(line => memberships.includes(line.split("\t")[0]));
		if (clients.length > 1) throw new DeviceRoutingError("ambiguous_attachment", "Multiple tmux clients can access this pane; cannot choose a voice device.");
		if (!clients.length) throw new DeviceRoutingError("attachment_unavailable", "No client is attached to this tmux pane's sessions.");
		const pid = clients[0].split("\t")[1];
		if (!/^[1-9]\d*$/.test(pid)) throw new Error("Invalid client PID");
		return { pid, key: `${[...new Set(memberships)].sort().join(",")}\n${clients[0]}` };
	};
	try {
		const before = await snapshot();
		const start = processStart(await io.read(`/proc/${before.pid}/stat`));
		const client = clientEnvironment(await io.read(`/proc/${before.pid}/environ`));
		// A nested tmux client inherits the outer pane's stale environment. Without
		// proving the outer attachment, fail rather than trusting that identity.
		if (client.TMUX) throw new DeviceRoutingError("attachment_unavailable", "Nested tmux connection identity cannot be resolved safely.");
		const resolved = identity(client, true);
		const after = await snapshot();
		if (before.key !== after.key || start !== processStart(await io.read(`/proc/${before.pid}/stat`))) {
			throw new DeviceRoutingError("attachment_changed", "The tmux attachment changed while resolving its voice device; retry.");
		}
		return resolved;
	} catch (error) {
		if (error instanceof DeviceRoutingError) throw error;
		throw new DeviceRoutingError("attachment_unavailable", "Cannot read the current tmux client identity; no fallback device was selected.");
	}
}
