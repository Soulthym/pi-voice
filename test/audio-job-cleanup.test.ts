import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const scripts = ["client/pi-voice-audio-session", "termux/pi-voice-audio-session"];
const source = fs.readFileSync(scripts[0], "utf8");
const functions = ["pi_voice_feeder", "stop_feeder", "pi_voice_player", "cleanup"].map(name => {
 const match = source.match(new RegExp(`^${name}\\(\\) \\{(?:[^\\n]*\\}|[\\s\\S]*?^\\})`, "m"));
 assert.ok(match, name);
 return match[0];
}).join("\n");

test("audio cleanup signals only named single-process jobs with monitor mode disabled", () => {
 assert.equal(source, fs.readFileSync(scripts[1], "utf8"));
 assert.match(source, /^set \+m$/m);
 assert.match(source, /pi_voice_player 9>&- > \/dev\/null 2>\/dev\/null &/);
 assert.match(source, /pi_voice_feeder <&3 9>&- >"\$audio_fifo" &/);
 const signals = source.split("\n").filter(line => /\bkill\s/.test(line) && !line.trim().startsWith("#"));
 assert.equal(signals.length, 3);
 assert.ok(signals.every(line => /builtin kill .*%pi_voice_(feeder|player)/.test(line)));
 assert.match(source, /\[\[ \$\{native_fields\[19\]:-\} == "\$bound_ticks" \]\] \|\| break/);
});

test("Bash job-spec kill never signals an asynchronously reaped child; blocked feeders terminate", t => {
 // Audit the actual libc kill calls, not kill's exit status or a PID existence
 // snapshot. Bash 5.2/5.3 jobs.c: kill_pid blocks SIGCHLD and tests PALIVE for
 // non-monitor jobs. kill.def's job-spec path selects that code, numeric $! does not.
 if (process.platform !== "linux") return t.skip("Linux LD_PRELOAD syscall audit");
 if (spawnSync("cc", ["--version"]).status !== 0) return t.skip("requires cc for kill-call audit");
 if (spawnSync("timeout", ["--version"]).status !== 0) return t.skip("requires GNU timeout for isolated failure cleanup");
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-job-audit-"));
 try {
  fs.writeFileSync(path.join(root, "audit.c"), `
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <sys/syscall.h>
int kill(pid_t pid, int sig) {
 FILE *f = fopen(getenv("SIGNAL_LOG"), "a");
 if (!f) _exit(99);
 fprintf(f, "%ld %d\\n", (long)pid, sig); fclose(f);
 return syscall(SYS_kill, pid, sig);
}
int killpg(pid_t group, int sig) { return kill(-group, sig); }
`);
  const compiled = spawnSync("cc", ["-shared", "-fPIC", "-o", path.join(root, "audit.so"), path.join(root, "audit.c")], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  fs.writeFileSync(path.join(root, "mpv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const log = path.join(root, "signals");
  fs.writeFileSync(log, "");
  const result = spawnSync("timeout", ["--signal=KILL", "8s", "bash", "-m", "-c", `
set -eu
set +m
${functions}
session_id=test; boot_id=test; state_dir=$PWD; audio_fifo=$PWD/fifo; ipc_socket=$PWD/ipc; script_dir=$PWD
# No wait before kill: the shell has already asynchronously reaped these jobs.
for i in {1..20}; do
 pi_voice_player &
 player=$!
 pi_voice_feeder </dev/null >/dev/null &
 feeder=$!
 sleep .02
 stop_feeder
 builtin kill -TERM %pi_voice_player 2>/dev/null || true
 wait "$player"
 wait "$feeder"
done
[[ ! -s "$SIGNAL_LOG" ]]
# A launcher has died while the native player remains alive, and a paused
# stream's feeder has finished. Exercise production cleanup after async reap.
native_survivor() { exec sleep 10; }
native_survivor &
native=$!
pi_voice_player &
mpv_pid=$!
pi_voice_feeder </dev/null >/dev/null &
feeder_pid=$!
sleep .02
player_exited=false; native_child=false; native_pid=$native; lock_held=false; renew_ack=
active_player_file=$PWD/active; player_lock=$PWD/lock; header_file=$PWD/header
# This fixture has no native binding: waiting for the launcher proves nothing.
publish_exit() { [[ $native_child == false ]]; }
cleanup
[[ ! -s "$SIGNAL_LOG" ]]
[[ -n $(jobs -pr %native_survivor) ]]
builtin kill -KILL %native_survivor
wait "$native" 2>/dev/null || true
: > "$SIGNAL_LOG"
# Abort both possible hangs: opening a FIFO with no reader, and reading stdin
# from an open FIFO with no data. KILL must reach only the live feeder job.
mkfifo "$audio_fifo"
exec 3<>"$audio_fifo"
for redirection in open read; do
 if [[ $redirection == open ]]; then
  mkfifo "$audio_fifo.blocked"
  pi_voice_feeder </dev/null >"$audio_fifo.blocked" &
 else
  pi_voice_feeder <&3 >/dev/null &
 fi
 feeder=$!
 sleep .02
 stop_feeder
 status=0; wait "$feeder" || status=$?
 [[ $status == 137 ]]
 printf '%s 9\\n' "$feeder" >> expected
done
cmp expected "$SIGNAL_LOG"
`], { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, LD_PRELOAD: path.join(root, "audit.so"), SIGNAL_LOG: log } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
 } finally {
  fs.rmSync(root, { recursive: true, force: true });
 }
});

for (const script of scripts) {
 test(`${script}: unsupported mpv ignoring TERM fails before audio without hanging`, { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-no-watchdog-"));
  // No real player, socket, network, provider, or user configuration.
  fs.writeFileSync(path.join(root, "mpv"), `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setTimeout(() => process.exit(99), 15000);\n`, { mode: 0o755 });
  const child = spawn("bash", [path.resolve(script)], {
   env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root, PATH: `${root}:${process.env.PATH}` },
  });
  let output = "", committed = false;
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdout.on("data", chunk => {
   output += chunk;
   const prepared = output.split("\n").find(line => line.includes('"type":"prepared"'));
   if (prepared && !committed) {
    committed = true;
    const scope = JSON.parse(prepared);
    child.stdin.end(`PI_VOICE_COMMIT ${scope.id} ${scope.boot_id}\n`);
   }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
  try {
   const exit = once(child, "exit");
   child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n");
   assert.deepEqual(await exit, [1, null]);
   const error = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === "error");
   assert.equal(error.phase, "native-bind");
   assert.match(error.message, /Native playback failed during native-bind/);
   assert.doesNotMatch(output, /"type":"session"/);
   const scopes = fs.readdirSync(path.join(root, "pi-voice/playback"));
   assert.equal(scopes.length, 1);
   assert.equal(fs.existsSync(path.join(root, "pi-voice/playback", scopes[0], "admission-intent")), false);
  } finally {
   clearTimeout(timer);
   child.kill("SIGKILL");
   fs.rmSync(root, { recursive: true, force: true });
  }
 });
}
