import * as net from "node:net";

const RECORDING_TIMEOUT_MS = 2 * 60_000;
const MAX_RESPONSE_CHARS = 12_000_000;

function parseEndpoint(endpoint: string): { host: string; port: number } {
	const url = new URL(endpoint);
	if (url.protocol !== "tcp:" || !url.hostname || !url.port) throw new Error(`Invalid phone input endpoint: ${endpoint}`);
	return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) };
}

export type PhoneCapture = { type: "audio"; data: Buffer } | { type: "text"; data: string };

export class PhoneInputClient {
	#socket: net.Socket | null = null;

	cancel(): void {
		this.#socket?.destroy();
		this.#socket = null;
	}

	capture(endpoint: string): Promise<PhoneCapture> {
		this.cancel();
		const { host, port } = parseEndpoint(endpoint);
		const socket = net.createConnection({ host, port });
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.setNoDelay(true);

		return new Promise<PhoneCapture>((resolve, reject) => {
			let settled = false;
			let buffer = "";
			const finish = (error?: Error, capture?: PhoneCapture): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (this.#socket === socket) this.#socket = null;
				socket.destroy();
				if (error) reject(error);
				else if (capture) resolve(capture);
				else reject(new Error("Phone returned no capture"));
			};
			const timer = setTimeout(() => finish(new Error("Phone microphone timed out")), RECORDING_TIMEOUT_MS);
			timer.unref?.();

			socket.on("connect", () => socket.write("record\n"));
			socket.on("data", chunk => {
				buffer += chunk;
				if (buffer.length > MAX_RESPONSE_CHARS) {
					finish(new Error("Phone microphone response was too large"));
					return;
				}
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const response = buffer.slice(0, newline).trim();
				const separator = response.indexOf(" ");
				const status = separator === -1 ? response : response.slice(0, separator);
				const payload = separator === -1 ? "" : response.slice(separator + 1);
				if (status === "audio") {
					const audio = Buffer.from(payload, "base64");
					if (audio.length === 0) finish(new Error("Phone returned an empty recording"));
					else finish(undefined, { type: "audio", data: audio });
					return;
				}
				const decoded = Buffer.from(payload, "base64").toString("utf8").trim();
				if (status === "ok") finish(undefined, { type: "text", data: decoded });
				else finish(new Error(decoded || "Phone microphone failed"));
			});
			socket.on("error", error => finish(error));
			socket.on("close", () => {
				if (!settled) finish(new Error("Phone microphone connection closed before returning audio"));
			});
		});
	}
}
