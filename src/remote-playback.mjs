import * as net from "node:net";

export const validStreamId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

export const validBootId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

export class RemotePlaybackUnconfirmedError extends Error {
	code = "REMOTE_PLAYBACK_UNCONFIRMED";
	constructor(message, options) {
		super(`Remote playback unconfirmed: ${message}. Restore the original device connection and retry /voice reconnect; ownership retained`, options);
		this.name = "RemotePlaybackUnconfirmedError";
	}
}

/** allowReboot requires persisted preparation identity and an independently matching responder. */
export function stopRemotePlayback({ output, id, bootId, deviceId, allowReboot = false }) {
	const rebootAllowed = allowReboot === true && typeof deviceId === "string" &&
		/^[a-zA-Z0-9._-]{1,128}$/.test(deviceId) && deviceId.trim() === deviceId && deviceId !== "legacy-loopback";
	return new Promise((resolve, reject) => {
		if (!validStreamId(id) || bootId !== undefined && bootId !== null && !validBootId(bootId)) return reject(new RemotePlaybackUnconfirmedError("invalid stream ID"));
		let endpoint;
		try {
			endpoint = new URL(output);
			if (!((endpoint.protocol === "tcp:" && endpoint.hostname && endpoint.port) ||
				(endpoint.protocol === "unix:" && !endpoint.hostname && endpoint.pathname.startsWith("/")))) throw new Error("invalid endpoint");
		} catch (cause) { return reject(new RemotePlaybackUnconfirmedError("invalid original endpoint", { cause })); }
		const peer = endpoint.protocol === "unix:"
			? net.createConnection({ path: decodeURIComponent(endpoint.pathname) })
			: net.createConnection({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port) });
		let reply = "";
		let ack = false;
		let failure;
		peer.setTimeout(1500, () => peer.destroy(new Error("control timed out")));
		peer.on("connect", () => peer.end(`PI_VOICE_CONTROLstop ${id}${rebootAllowed && validBootId(bootId) ? ` ${bootId}` : ""}\n`));
		peer.on("data", chunk => {
			reply += chunk;
			if (reply.length > 8192) return peer.destroy(new Error("invalid control response"));
			for (;;) {
				const end = reply.indexOf("\n");
				if (end < 0) break;
				try {
					const event = JSON.parse(reply.slice(0, end));
					if (event.type === "stopped" && event.id === id) {
						if (event.proof === "reboot") {
							if (rebootAllowed && event.device_id === deviceId && validBootId(bootId) && event.expected_boot_id === bootId &&
								validBootId(event.boot_id) && event.boot_id !== bootId) ack = true;
						} else if (event.proof === undefined && (bootId === undefined || event.boot_id === bootId)) ack = true;
					}
				} catch {}
				reply = reply.slice(end + 1);
			}
		});
		peer.on("error", error => { failure = error; });
		peer.on("close", () => ack ? resolve() : reject(new RemotePlaybackUnconfirmedError(failure?.message ?? "missing scoped player-exit receipt", { cause: failure })));
	});
}
