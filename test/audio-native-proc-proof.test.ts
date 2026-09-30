import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
 const fn = source.slice(source.indexOf("native_gone() {"), source.indexOf("\npublish_native_exit()"));
 const binding = `${id} ${boot} 424242 222 ${process.getuid!()} ${fs.readlinkSync("/proc/self/ns/pid")} ${fs.readlinkSync("/proc/self/ns/mnt")}\n`;
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("XDG_")));
 Object.assign(env, { HOME: root, TMPDIR: root, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root });
 try {
  for (const mode of ["absent", "reused", "live", "listing-error", "stat-error", "stat-malformed", "mount-error", "hidepid", "other-boot", "unknown-boot", "namespace", "uid", "legacy-unbound", "uncommitted"]) {
   fs.writeFileSync(`${scope}/bound`, mode === "namespace" ? binding.replace(/pid:\[\d+\]/, "pid:[1]") : mode === "uid" ? binding.replace(` 222 ${process.getuid!()} `, " 222 999999 ") : binding);
   fs.writeFileSync(`${scope}/committed`, "");
   if (mode === "legacy-unbound") fs.unlinkSync(`${scope}/bound`);
   if (mode === "uncommitted") fs.unlinkSync(`${scope}/committed`);
   const result = spawnSync("bash", ["-c", `
set -u
${fn}
boot_id='"${boot}"'
[[ $MODE != unknown-boot ]] || boot_id=null
kernel_boot() { [[ $MODE == other-boot ]] && printf '"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"' || printf '%s' "$boot_id"; }
ls() { [[ $MODE == listing-error ]] && return 1; [[ $MODE == absent ]] && printf '1\\n2\\n' || printf '424242\\n'; }
cat() {
 case "$1" in
 /proc/mounts)
  [[ $MODE != mount-error ]] || return 1
  [[ $MODE == hidepid ]] && printf 'proc /proc proc rw,hidepid=2 0 0\\n' || printf 'proc /proc proc rw 0 0\\n';;
 /proc/424242/stat)
  [[ $MODE != stat-error ]] || return 1
  [[ $MODE != stat-malformed ]] || { printf 'broken'; return; }
  printf '424242 (native name (nested)) S'
  for ((i=0;i<18;i++)); do printf ' 0'; done
  [[ $MODE == reused ]] && printf ' 333\\n' || printf ' 222\\n';;
 *) command cat "$@";;
 esac
}
native_gone '${scope}'
`], { env: { ...env, MODE: mode }, encoding: "utf8" });
   assert.equal(result.status, ["absent", "reused"].includes(mode) ? 0 : 1, `${mode}: ${result.stderr}`);
  }
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
