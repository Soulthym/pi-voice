import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";

// Opt-in cached image only: no pull/build, networking, host HOME/device mounts,
// or host mpv. The image must already contain node, mpv with Lua, and readlink.
test("real mpv native watchdog in an audio-null container", { timeout: 90000 }, t => {
 const image = process.env.PI_VOICE_TEST_MPV_IMAGE;
 if (!image) return t.skip("set PI_VOICE_TEST_MPV_IMAGE to a cached image containing mpv and node");
 const run = (...args: string[]) => {
  const result = spawnSync("podman", args, { encoding: "utf8", timeout: 65000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${args[0]}: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
 };
 const name = `pi-voice-mpv-test-${process.pid}`;
 try {
  run("create", "--pull=never", "--network=none", "--cap-drop=all", "--security-opt=no-new-privileges",
   "--name", name, "--entrypoint", "/bin/sh",
   "--env", "HOME=/work/home", "--env", "XDG_CONFIG_HOME=/work/config",
   "--env", "XDG_STATE_HOME=/work/state", "--env", "XDG_CACHE_HOME=/work/cache",
   "--env", "XDG_RUNTIME_DIR=/work/runtime", "--env", "PI_CODING_AGENT_DIR=/work/pi",
   image, "-c", "mkdir -p /work/home /work/config /work/state /work/cache /work/runtime /work/pi; cp /tmp/pi-voice-mpv-watchdog.lua /work/; exec node /tmp/mpv-watchdog-sandbox.mjs");
  run("cp", path.resolve("test/helpers/mpv-watchdog-sandbox.mjs"), `${name}:/tmp/mpv-watchdog-sandbox.mjs`);
  run("cp", path.resolve("client/pi-voice-mpv-watchdog.lua"), `${name}:/tmp/pi-voice-mpv-watchdog.lua`);
  assert.equal(run("start", "--attach", name).split("\n").filter(line => line.startsWith("PASS real mpv")).length, 3);
 } finally {
  spawnSync("podman", ["rm", "--ignore", "-f", "-t", "1", name], { timeout: 15000 });
 }
});
