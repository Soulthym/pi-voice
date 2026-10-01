import fs from 'node:fs';

// Container runtimes overlay /proc/sys. Model an unrestricted proc mount view
// explicitly in TEST COPIES only; production mount validation still executes.
// PID/stat/boot/UID remain real; optional namespace capabilities are modeled.
// This is not an Android device.
export function trustedProcSandbox(directory) {
 const mounts = `${directory}/trusted-mountinfo`;
 fs.writeFileSync(mounts, '1 0 0:1 / /proc rw,nosuid,nodev,noexec - proc proc rw\n');
 const shell = `${directory}/pi-voice-audio-session`;
 fs.writeFileSync(shell, fs.readFileSync(shell, 'utf8').replaceAll('/proc/self/mountinfo', mounts));
 const lua = `${directory}/pi-voice-mpv-watchdog.lua`;
 fs.writeFileSync(lua, `local fixture_open = io.open
io.open = function(file, mode)
 if file == '/proc/sys/kernel/osrelease' and os.getenv('PI_VOICE_TEST_ANDROID') == '1' then return nil, 'Permission denied' end
 if file == '/proc/self/mountinfo' then file = '${mounts}' end
 return fixture_open(file, mode)
end
` + fs.readFileSync(lua, 'utf8'));
 // Opt-in Android 5.4-vendor model: absent PID/time names, readable real mnt.
 const bin = `${directory}/namespace-bin`;
 fs.mkdirSync(bin);
 for (const [command, injected] of Object.entries({
  uname: `if [ "$1" = -r ]; then printf '5.4.0-vendor\\n'; exit; fi`,
  ls: `case "\${*: -1}" in /proc/*/ns) printf 'mnt\\nnet\\nuser\\nuts\\n'; exit;; esac`,
  readlink: `case "$1" in /proc/*/ns/pid|/proc/*/ns/time) exit 1;; esac`,
  cat: `if [ "$1" = /proc/sys/kernel/osrelease ]; then exit 1; fi`,
 })) fs.writeFileSync(`${bin}/${command}`, `#!/bin/bash\nif [[ $PI_VOICE_TEST_ANDROID == 1 ]]; then ${injected}; fi\nexec /usr/bin/${command} "$@"\n`, {mode:0o755});
 process.env.PATH = `${bin}:${process.env.PATH}`;
 console.log('Synthetic trusted proc mount view; optional Android 5.4-vendor metadata model, NOT Android hardware');
}
