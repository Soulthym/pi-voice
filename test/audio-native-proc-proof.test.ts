import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { namespaceCases, namespaceFixture } from './helpers/namespace-fixture.js';

test('binding-v4 Python native proof: Android hidepid=2, pidfd failures, and real Linux pidfd', () => {
 const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_native_proof.py'], { encoding: 'utf8', timeout: 15000 });
 assert.equal(result.error, undefined);
 assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const directory of ['client', 'termux']) test(`${directory}: binding-v3 synthetic capability recovery requires trusted proc visibility`, () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-proc-proof-'));
 const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
 const scope = `${root}/${id}`; fs.mkdirSync(scope);
 const source = fs.readFileSync(`${directory}/pi-voice-audio-session`, 'utf8');
 // Model a trusted proc mount explicitly; never bypass trusted_proc validation.
 const fn = source.slice(source.indexOf('trusted_proc() {'), source.indexOf('\npublish_exit()'))
  .replaceAll('/proc/self/mountinfo', `${root}/mounts`);
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PI_') && !key.startsWith('XDG_')));
 Object.assign(env, { HOME: root, TMPDIR: root, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root });
 try {
  for (const mode of [...namespaceCases, 'mount-reader-error', 'absent', 'live', 'listing-error', 'stat-error', 'stat-malformed', 'other-boot', 'unknown-boot', 'namespace', 'uid', 'legacy-unbound', 'uncommitted', 'old-binding', 'v2-binding', 'unknown-version', 'changed-time', 'backport-changed-time', 'missing-time', 'binding-nul', 'binding-newline', 'binding-long']) {
   const model = namespaceFixture(mode === 'backport-changed-time' ? 'old-present' : mode);
   for (const key of ['mounts', 'release', 'listing'] as const) fs.writeFileSync(`${root}/${key}`, model[key]);
   if (mode === 'mount-error') fs.unlinkSync(`${root}/mounts`);
   let binding = `${id} ${boot} 424242 222 ${process.getuid!()} ${model.pid} mnt:[123] binding-v3 ${model.time}\n`;
   if (mode === 'namespace') binding = binding.replace('pid:[123]', 'pid:[1]');
   if (mode === 'uid') binding = binding.replace(` 222 ${process.getuid!()} `, ' 222 999999 ');
   if (mode === 'old-binding') binding = binding.replace(' binding-v3 time:[123]', '');
   if (mode === 'v2-binding') binding = binding.replace('binding-v3', 'binding-v2');
   if (mode === 'unknown-version') binding = binding.replace('binding-v3', 'binding-v99');
   if (mode === 'missing-time') binding = binding.replace(' time:[123]', '');
   if (mode === 'binding-nul') binding = binding.replace('binding-v3', 'binding-v3\0');
   if (mode === 'binding-newline') binding += '\n';
   if (mode === 'binding-long') binding += 'a'.repeat(1024);
   fs.writeFileSync(`${scope}/bound`, binding);
   fs.writeFileSync(`${scope}/committed`, '');
   fs.rmSync(`${scope}/exited`, { force: true });
   fs.rmSync(`${root}/stat-read`, { force: true });
   if (mode === 'legacy-unbound') fs.unlinkSync(`${scope}/bound`);
   if (mode === 'uncommitted') fs.unlinkSync(`${scope}/committed`);
   const result = spawnSync('bash', ['-c', `
set -u
${fn}
boot_id='"${boot}"'
state_dir='${scope}'
native_child=false
[[ $MODE != unknown-boot ]] || boot_id=null
kernel_boot() { [[ $MODE == other-boot ]] && printf '"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"' || printf '%s' "$boot_id"; }
uname() { [[ $* == -r && $MODE != uname-error ]] || return 1; command cat '${root}/release'; }
readlink() {
 local name=\${1##*/}
 [[ $MODE != android || $name == mnt ]] || { touch '${root}/absent-read'; return 1; }
 [[ $MODE != "$name-denied" && $MODE != "old-$name-denied" ]] || return 1
 case $MODE in
  link-malformed) printf '%s:[123] garbage\\n' "$name";;
  link-nul) printf '%s:[123]\\0\\n' "$name";;
  link-long) printf '%s:[123456789012345678901]\\n' "$name";;
  changed-time|backport-changed-time) [[ $name != time ]] && printf '%s:[123]\\n' "$name" || printf 'time:[456]\\n';;
  *) printf '%s:[123]\\n' "$name";;
 esac
}
ls() {
 if [[ \${*: -1} == /proc/self/ns ]]; then
  [[ $MODE != list-error && $MODE != old-list-error ]] || return 1
  command cat '${root}/listing'; return
 fi
 [[ $MODE != listing-error ]] || return 1
 [[ $MODE == absent || $MODE == android ]] && printf '1\\n2\\n' || printf '424242\\n'
}
cat() {
 case "$1" in
 '${root}/mounts')
  command cat "$@"
  # A complete valid prefix followed by EIO must not establish visibility.
  [[ $MODE != mount-reader-error ]];;
 /proc/sys/kernel/osrelease) touch '${root}/osrelease-read'; return 1;;
 /proc/424242/stat)
  touch '${root}/stat-read'
  [[ $MODE != stat-error ]] || return 1
  [[ $MODE != stat-malformed ]] || { printf broken; return; }
  printf '424242 (native name (nested)) S'
  for ((i=0;i<18;i++)); do printf ' 0'; done
  [[ $MODE == live ]] && printf ' 222\\n' || printf ' 333\\n';;
 *) command cat "$@";;
 esac
}
publish_native_exit '${scope}'
`], { env: { ...env, MODE: mode }, encoding: 'utf8' });
   const accepted = (model.accepted && !mode.includes('changed-time')) || mode === 'absent';
   assert.equal(result.status, accepted ? 0 : 1, `${mode}: ${result.stderr}`);
   assert.equal(fs.existsSync(`${scope}/exited`), accepted, mode);
   if (accepted) assert.deepEqual(JSON.parse(fs.readFileSync(`${scope}/exited`, 'utf8')), { id, boot_id: boot, proof: 'native-process-exit' });
   if (mode.includes('changed-time')) assert.equal(fs.existsSync(`${root}/stat-read`), false, 'changed domain cannot consult misleading reused ticks');
   assert.equal(fs.existsSync(`${root}/osrelease-read`), false);
   assert.equal(fs.existsSync(`${root}/absent-read`), false);
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
  fs.writeFileSync(`${scope}/bound`, `${id} ${boot} ${pid} ${ticks} ${process.getuid!()} ${fs.readlinkSync('/proc/self/ns/pid')} ${fs.readlinkSync('/proc/self/ns/mnt')} binding-v3 ${timens}\n`);
  fs.writeFileSync(`${scope}/committed`, '');
  const source = fs.readFileSync(`${directory}/pi-voice-audio-session`, 'utf8');
  const functions = source.slice(source.indexOf('trusted_proc() {'), source.indexOf('\npublish_exit()'));
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
