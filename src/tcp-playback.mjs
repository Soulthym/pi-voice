import * as fs from "node:fs";
import * as net from "node:net";

const [output, sampleRateValue, utteranceValue] = process.argv.slice(2);
const sampleRate = Number(sampleRateValue);
const utterance = Number(utteranceValue);
const control = fs.createWriteStream(null, { fd: 3, autoClose: false });
let stopped = false;
let startedAt = null;
let lastFeedbackAt = performance.now();
let samplesWritten = 0;
let feedback = "";

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function controlLine(line) {
	try {
		control.write(`${line.replace(/\r?\n/g, " ")}\n`);
	} catch {
		// The parent may have already stopped the playback helper.
	}
}

function fail(error) {
	if (stopped) return;
	stopped = true;
	const message = error instanceof Error ? error.message : String(error);
	controlLine(`error ${message}`);
	send({ type: "error", message });
	process.exitCode = 1;
}

let endpoint;
try {
	endpoint = new URL(output);
	if (
		!((endpoint.protocol === "tcp:" && endpoint.hostname && endpoint.port) ||
			(endpoint.protocol === "unix:" && !endpoint.hostname && endpoint.pathname.startsWith("/")))
	) {
		throw new Error(`Invalid network output: ${output}`);
	}
	if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(utterance)) {
		throw new Error("Invalid TCP playback parameters");
	}
} catch (error) {
	fail(error);
	process.exit(1);
}

const socket =
	endpoint.protocol === "unix:"
		? net.createConnection({ path: decodeURIComponent(endpoint.pathname) })
		: net.createConnection({
				host: endpoint.hostname.replace(/^\[|\]$/g, ""),
				port: Number(endpoint.port),
			});
socket.setNoDelay(true);

const timer = setInterval(() => {
	if (startedAt === null || performance.now() - lastFeedbackAt < 750) return;
	const position = Math.min((performance.now() - startedAt) / 1_000, samplesWritten / sampleRate);
	send({ type: "playback", utterance, position, estimated: true });
}, 125);
timer.unref?.();

process.stdin.on("data", chunk => {
	if (startedAt === null) startedAt = performance.now();
	samplesWritten += Math.floor(chunk.length / Float32Array.BYTES_PER_ELEMENT);
});
process.stdin.on("error", fail);
process.stdin.on("end", () => socket.end());

socket.on("connect", () => {
	controlLine("ready");
	process.stdin.pipe(socket, { end: false });
});

socket.on("data", chunk => {
	feedback = `${feedback}${String(chunk)}`.slice(-8_192);
	for (;;) {
		const newline = feedback.indexOf("\n");
		if (newline < 0) break;
		const line = feedback.slice(0, newline);
		feedback = feedback.slice(newline + 1);
		try {
			const event = JSON.parse(line);
			const position = Number(event.position);
			if (event.type === "playback" && Number.isFinite(position) && position >= 0) {
				lastFeedbackAt = performance.now();
				send({ type: "playback", utterance, position });
			}
		} catch {
			// Ignore malformed feedback from an interrupted phone session.
		}
	}
});

socket.on("error", fail);
socket.on("close", () => {
	clearInterval(timer);
	process.stdin.destroy();
	control.end();
	if (!stopped) process.exitCode = 0;
});
