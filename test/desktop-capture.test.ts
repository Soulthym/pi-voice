import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PhoneInputClient } from "../src/phone-input.js";

// Real desktop protocol + encoder + host decoder; only the microphone is fake.
// New libsndfile families are fixtures, not claims of a second installed version.
for (const family of ["native", "WAV", "AU"]) for (const source of ["failed", "empty", "pcm", "stopped", "help-failed", "help-timeout", "help-large"]) test(`desktop capture: ${family} ${source} recorder with real ffmpeg`, async t => {
	assert.equal(spawnSync("ffmpeg", ["-version"]).status, 0, "ffmpeg is required for this regression");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-desktop-capture-"));
	const bin = path.join(root, "bin"); await fs.mkdir(bin);
	// The stopped fixture must outlast ffmpeg's input probing so it can emit Ogg before stop.
	const pcm = Buffer.alloc(source === "stopped" ? 6 * 16000 * 2 : 16000);
	for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 16000)), i * 2);
	await fs.writeFile(path.join(root, "synthetic.pcm"), pcm);
	for (const [name, body] of Object.entries({
		wpctl: "exit 0", pactl: "exit 1",
		"pw-record": source === "stopped" ? 'cat "$TMPDIR/synthetic.pcm"; touch "$TMPDIR/ready"; exec sleep 30'
			: source === "pcm" ? 'cat "$TMPDIR/synthetic.pcm"' : `echo private-recorder-diagnostic >&2; exit ${source === "failed" ? 1 : 0}`,
	})) await fs.writeFile(path.join(bin, name), `#!/bin/bash
${name === "pw-record" ? `if [[ $1 == --help ]]; then
  ${source === "help-failed" ? "exit 1" : source === "help-timeout" ? "sleep 30" : `echo 'Usage: pw-record ${family === "native" ? "" : "--raw"}'; head -c ${source === "help-large" ? 70000 : 60000} /dev/zero | tr '\\0' ' '`}
  exit 0
fi
printf '%s' "$*" > "$TMPDIR/flags"
${family === "native" ? '[[ $1 != --raw ]] || exit 2' : `if [[ $1 != --raw ]]; then printf '${family === "WAV" ? "RIFFfixtureWAVE" : ".sndfixture"}'; else shift; fi`}
[[ "$*" == "--format s16 --rate 16000 --channels 1 -" ]] || exit 2` : ""}
${body}
`, { mode: 0o755 });
	const env = { ...process.env, PREFIX: "", PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, XDG_RUNTIME_DIR: root, PI_VOICE_MAX_RECORD_SECONDS: "5" };
	const children: Promise<void>[] = [];
	const wire: Buffer[] = [];
	const server = net.createServer(socket => {
		const child = spawn("bash", [path.resolve("client/pi-voice-stt-session")], { env });
		children.push(new Promise(resolve => child.once("close", () => resolve())));
		child.stderr.resume(); child.stdin.on("error", () => {}); socket.on("error", () => {});
		socket.pipe(child.stdin); child.stdout.pipe(socket);
		child.stdout.on("data", chunk => wire.push(chunk));
		socket.on("close", () => child.stdin.end());
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
		await Promise.all(children);
		await fs.rm(root, { recursive: true, force: true });
	});
	const address = server.address(); assert.ok(address && typeof address === "object");
	const client = new PhoneInputClient();
	let samples = 0;
	const capture = client.capture(`tcp://127.0.0.1:${address.port}`, { onAudio: audio => { samples += audio.length; } });
	if (source === "stopped") {
		for (let i = 0; i < 400; i++) {
			if (Buffer.concat(wire).includes(Buffer.from("stream\nOggS")) && await fs.stat(path.join(root, "ready")).catch(() => false)) break;
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.ok(await fs.stat(path.join(root, "ready")));
		assert.ok(Buffer.concat(wire).includes(Buffer.from("stream\nOggS")), "encoder must produce Ogg before stop");
		await client.stop();
	}
	if (source === "pcm" || source === "stopped") {
		assert.equal((await capture).type, "audio");
		assert.equal(samples, pcm.length / 2, "encoder/decoder must flush all synthetic samples");
	} else {
		await assert.rejects(capture, source.startsWith("help-") ? /Could not inspect pw-record raw PCM support/ : /no decodable audio; check the selected device's recorder, microphone access, and audio tools/);
		assert.equal(samples, 0);
	}
	await client.stop();
	const output = Buffer.concat(wire);
	if (source.startsWith("help-")) {
		assert.ok(!output.includes(Buffer.from("stream\n")));
		assert.equal(await fs.stat(path.join(root, "flags")).catch(() => false), false);
	} else {
		assert.equal(await fs.readFile(path.join(root, "flags"), "utf8"), `${family === "native" ? "" : "--raw "}--format s16 --rate 16000 --channels 1 -`);
		assert.ok(output.includes(Buffer.from("stream\nOggS")), "even a failed/empty source produces an Ogg header");
	}
	assert.ok(!output.includes(Buffer.from("private-recorder-diagnostic")));
	assert.match(output.toString(), /ok /, "capture still requires the ticket-bound stop receipt");
});
