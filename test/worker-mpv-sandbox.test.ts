import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// Explicit cached image; no host mounts, devices, network, models or providers.
test("Socket VoiceWorkerClient reaches real mpv while paused before any PCM", { timeout: 90000 }, async t => {
 const image = process.env.PI_VOICE_TEST_MPV_IMAGE;
 if (!image) return t.skip("set PI_VOICE_TEST_MPV_IMAGE to a cached image with Node >=24, mpv, socat and Python");
 const stage = await fs.mkdtemp(path.join(os.tmpdir(), "voice-host-mpv-"));
 const name = `pi-voice-host-mpv-${process.pid}`;
 const run = (...args: string[]) => {
  const result = spawnSync("podman", args, { encoding: "utf8", timeout: 65000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${args[0]}: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
 };
 try {
  await fs.cp("src", path.join(stage, "src"), { recursive: true });
  for (const file of ["worker-client", "config"]) {
   const source = await fs.readFile(`src/${file}.ts`, "utf8");
   await fs.writeFile(path.join(stage, "src", `${file}.js`), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
   }).outputText);
  }
  await fs.writeFile(path.join(stage, "package.json"), '{"type":"module"}');
  // Resolution-only packages: the existing transport fixture mocks all exports.
  for (const pkg of ["@huggingface/transformers", "kokoro-js"]) {
   const dir = path.join(stage, "node_modules", pkg);
   await fs.mkdir(dir, { recursive: true });
   await fs.writeFile(path.join(dir, "package.json"), '{"type":"module","exports":"./index.mjs"}');
   await fs.writeFile(path.join(dir, "index.mjs"), 'throw Error("Provider import escaped test mock");');
  }
  for (const file of ["worker-mpv-sandbox.mjs", "worker-transport-mocks.mjs", "trusted-proc-sandbox.mjs"]) {
   await fs.copyFile(`test/helpers/${file}`, path.join(stage, file));
  }
  for (const file of ["pi-voice-audio-session", "pi-voice-mpv-watchdog.lua"]) {
   await fs.copyFile(`client/${file}`, path.join(stage, file));
  }
  run("create", "--pull=never", "--network=none", "--init", "--cap-drop=all", "--security-opt=no-new-privileges",
   "--name", name, "--tmpfs", "/work:rw,mode=1777", "--entrypoint", "/bin/sh",
   "--env", "HOME=/work/home", "--env", "XDG_CONFIG_HOME=/work/config", "--env", "XDG_STATE_HOME=/work/state",
   "--env", "XDG_CACHE_HOME=/work/cache", "--env", "XDG_RUNTIME_DIR=/work/runtime", "--env", "PI_CODING_AGENT_DIR=/work/pi",
   "--env", "HF_HUB_OFFLINE=1", image, "-c",
   "mkdir -p /work/home /work/config /work/state /work/cache /work/runtime /work/pi; cp -r /tmp/fixture /work/fixture; cd /work/fixture; exec node --experimental-test-module-mocks worker-mpv-sandbox.mjs");
  run("cp", stage, `${name}:/tmp/fixture`);
  const output = run("start", "--attach", name);
  t.diagnostic(output);
  assert.equal(output.split("\n").filter(line => line.startsWith("PASS host")).length, 4);
 } finally {
  spawnSync("podman", ["rm", "--ignore", "-f", "-t", "1", name], { timeout: 15000 });
  await fs.rm(stage, { recursive: true, force: true });
 }
});
