import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

for (const directory of ["client", "termux"]) test(`${directory}: native exit proof requires trustworthy same-boot proc visibility`, () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-proc-proof-"));
 const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
 const scope = `${root}/${id}`; fs.mkdirSync(scope);
 const source = fs.readFileSync(`${directory}/pi-voice-audio-session`, "utf8");
 const fn = source.slice(source.indexOf("reader_timens() {"), source.indexOf("\npublish_native_exit()"));
 const binding = `${id} ${boot} 424242 222 ${process.getuid!()} ${fs.readlinkSync("/proc/self/ns/pid")} ${fs.readlinkSync("/proc/self/ns/mnt")} binding-v2 time:[123]\n`;
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("XDG_")));
 Object.assign(env, { HOME: root, TMPDIR: root, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root });
 try {
  for (const mode of ["absent", "reused", "live", "listing-error", "stat-error", "stat-malformed", "mount-error", "hidepid", "other-boot", "unknown-boot", "namespace", "uid", "legacy-unbound", "uncommitted", "old-binding", "unknown-version", "timens", "time-read-error", "time-malformed", "modern-absent", "old-unsupported", "old-present", "old-list-error", "old-hidden", "old-read-error", "missing-timens", "release-error"]) {
   fs.writeFileSync(`${scope}/bound`, mode === "namespace" ? binding.replace(/pid:\[\d+\]/, "pid:[1]") : mode === "uid" ? binding.replace(` 222 ${process.getuid!()} `, " 222 999999 ") : binding);
   if (mode === 'old-binding') fs.writeFileSync(`${scope}/bound`, binding.replace(/ binding-v2 time:\[123\]/, ''));
   if (mode === 'unknown-version') fs.writeFileSync(`${scope}/bound`, binding.replace('binding-v2', 'binding-v1'));
   if (mode === 'missing-timens') fs.writeFileSync(`${scope}/bound`, binding.replace(' time:[123]', ''));
   if (mode.startsWith('old-') && !['old-binding', 'old-present'].includes(mode)) fs.writeFileSync(`${scope}/bound`, binding.replace('time:[123]', 'unsupported-pre5.6'));
   fs.writeFileSync(`${scope}/committed`, "");
   if (mode === "legacy-unbound") fs.unlinkSync(`${scope}/bound`);
   if (mode === "uncommitted") fs.unlinkSync(`${scope}/committed`);
   const result = spawnSync("bash", ["-c", `
set -u
${fn}
boot_id='"${boot}"'
[[ $MODE != unknown-boot ]] || boot_id=null
kernel_boot() { [[ $MODE == other-boot ]] && printf '"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"' || printf '%s' "$boot_id"; }
readlink() {
 if [[ $1 == /proc/self/ns/time ]]; then
  case $MODE in
   time-read-error|modern-absent|old-read-error) return 1;;
   timens) printf 'time:[456]';;
   time-malformed) printf 'broken';;
   *) printf 'time:[123]';;
  esac
 else command readlink "$@"; fi
}
ls() { if [[ \${*: -1} == /proc/self/ns ]]; then
 [[ $MODE != old-list-error ]] || return 1
 [[ $MODE != old-hidden ]] || return 0
 [[ $MODE != old-read-error && $MODE != old-present ]] || { printf 'pid\\nmnt\\ntime\\n'; return; }
 printf 'pid\\nmnt\\n'; return
 fi
 [[ $MODE == listing-error ]] && return 1; [[ $MODE == absent ]] && printf '1\\n2\\n' || printf '424242\\n'; }
cat() {
 case "$1" in
 /proc/sys/kernel/osrelease)
  [[ $MODE != release-error ]] || return 1
  [[ $MODE == old-* ]] && printf '5.4.0' || printf '6.8.0';;
 /proc/mounts)
  [[ $MODE != mount-error ]] || return 1
  [[ $MODE == hidepid ]] && printf 'proc /proc proc rw,hidepid=2 0 0\\n' || printf 'proc /proc proc rw 0 0\\n';;
 /proc/424242/stat)
  [[ $MODE != stat-error ]] || return 1
  [[ $MODE != stat-malformed ]] || { printf 'broken'; return; }
  printf '424242 (native name (nested)) S'
  for ((i=0;i<18;i++)); do printf ' 0'; done
  [[ $MODE == reused || $MODE == old-unsupported || $MODE == old-present || $MODE == timens ]] && printf ' 333\\n' || printf ' 222\\n';;
 *) command cat "$@";;
 esac
}
native_gone '${scope}'
`], { env: { ...env, MODE: mode }, encoding: "utf8" });
   assert.equal(result.status, ["absent", "reused", "old-unsupported", "old-present"].includes(mode) ? 0 : 1, `${mode}: ${result.stderr}`);
  }
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const directory of ['client', 'termux']) test(`${directory}: stopped live PID stays fenced across reader time domains`, async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-timens-'));
 const child = spawn('sleep', ['60']);
 const exited = new Promise(resolve => child.once('exit', resolve));
 try {
  const pid = child.pid!;
  child.kill('SIGSTOP');
  for (let i = 0; i < 100; i++) {
   if (fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') T ')) break;
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  assert.ok(stat.includes(') T '));
  const ticks = stat.replace(/^.*\) /, '').split(' ')[19];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const scope = `${root}/${id}`; fs.mkdirSync(scope);
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const timens = fs.readlinkSync('/proc/self/ns/time');
  fs.writeFileSync(`${scope}/bound`, `${id} ${boot} ${pid} ${ticks} ${process.getuid!()} ${fs.readlinkSync('/proc/self/ns/pid')} ${fs.readlinkSync('/proc/self/ns/mnt')} binding-v2 ${timens}\n`);
  fs.writeFileSync(`${scope}/committed`, '');
  const source = fs.readFileSync(`${directory}/pi-voice-audio-session`, 'utf8');
  const functions = source.slice(source.indexOf('reader_timens() {'), source.indexOf('\npublish_exit()'));
  const setup = `${functions}\nboot_id='"${boot}"'\nstate_dir='${scope}'\nnative_child=false\nkernel_boot() { printf '%s' "$boot_id"; }\n`;
  // Same live, stopped PID and a deliberately different observed tick value.
  // The domain guard must reject BEFORE reading that misleading stat at all.
  const injected = spawnSync('bash', ['-c', `${setup}
readlink() { if [[ $1 == /proc/self/ns/time ]]; then printf 'time:[1]'; else command readlink "$@"; fi; }
cat() { if [[ $1 == /proc/${pid}/stat ]]; then touch '${root}/stat-read'; printf '%s' '${stat.replace(` ${ticks} `, ` ${BigInt(ticks) + 100n} `).trim()}'; else command cat "$@"; fi; }
publish_native_exit '${scope}'
`], { encoding: 'utf8' });
  assert.equal(injected.status, 1, injected.stderr);
  assert.equal(fs.existsSync(`${root}/stat-read`), false);
  assert.equal(fs.existsSync(`${scope}/exited`), false);
  assert.ok(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') T '));

  const available = spawnSync('unshare', ['--user', '--map-root-user', '--time', '--monotonic', '100', '--boottime', '100', '--fork', 'true']);
  if (available.status !== 0) { t.diagnostic(`time namespace fixture unavailable: ${available.stderr}`); return; }
  const actual = spawnSync('unshare', ['--user', '--map-root-user', '--time', '--monotonic', '100', '--boottime', '100', '--fork', 'bash', '-c', `${setup}
[[ $(readlink /proc/self/ns/time) != '${timens}' ]] || exit 90
stat=$(cat /proc/${pid}/stat); tail=\${stat##*) }; read -r -a fields <<<"$tail"
[[ \${fields[19]} != '${ticks}' ]] || exit 91
# User namespace changes UID; inject only that independent guard to reach timens.
id() { printf '${process.getuid!()}'; }
publish_native_exit '${scope}'
`], { encoding: 'utf8' });
  assert.equal(actual.status, 1, actual.stderr);
  assert.equal(fs.existsSync(`${scope}/exited`), false);
  assert.ok(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') T '));
 } finally {
  child.kill('SIGKILL'); await exited;
  fs.rmSync(root, { recursive: true, force: true });
 }
});
