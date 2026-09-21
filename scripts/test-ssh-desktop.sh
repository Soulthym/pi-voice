#!/usr/bin/env bash
# Opt-in, synthetic audio only. No host mounts, published ports, or live sessions.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(mktemp -d)
name=pi-voice-test-$$-$RANDOM
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then
    echo "Desktop SSH test failed (exit $status); bounded container diagnostics:" >&2
    podman exec "$name-server" tail -c 4096 /work/sshd.log >&2 2>/dev/null || true
    podman exec "$name-client" bash -c 'tail -c 4096 /work/runtime/pi-voice-ssh-*/client-bridge.log /work/pipewire.log /work/wireplumber.log' >&2 2>/dev/null || true
  fi
  # Remove the dependent network-namespace client BEFORE its server.
  for role in client server; do
    if podman container exists "$name-$role"; then
      podman rm -f -t 1 "$name-$role" >/dev/null || { (( status != 0 )) || status=1; }
    fi
  done
  if podman image exists "$name"; then
    podman rmi "$name" >/dev/null || { (( status != 0 )) || status=1; }
  fi
  rm -rf "$root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(podman info --format '{{.Host.Security.Rootless}}') == true ]]
podman build -t "$name" scripts/ssh-desktop
# Shared PRIVATE loopback avoids requiring a kernel bridge or any host networking.
podman run -d --label "io.pi-voice.ssh-desktop=$name" --name "$name-server" --network none "$name" >/dev/null
podman run -d --label "io.pi-voice.ssh-desktop=$name" --name "$name-client" --network "container:$name-server" "$name" >/dev/null
for role in client server; do
  podman cp client "$name-$role:/work/client"
done
# Tripwire: the decoder's local capture path must never run on the server.
podman exec "$name-server" bash -c 'printf "#!/bin/sh\ntouch /work/host-capture-called\nexit 1\n" > /work/client/pi-voice-stt-session'
ssh-keygen -q -t ed25519 -N '' -f "$root/key"
ssh-keygen -q -t ed25519 -N '' -f "$root/host"
printf '[127.0.0.1]:2222 %s\n' "$(<"$root/host.pub")" >"$root/known_hosts"
podman cp "$root/key" "$name-client:/work/key"
podman cp "$root/known_hosts" "$name-client:/work/known_hosts"
podman cp "$root/key.pub" "$name-server:/work/authorized_keys"
podman cp "$root/host" "$name-server:/work/host"
printf '%s\n' 'Port 2222' 'HostKey /work/host' 'AuthorizedKeysFile /work/authorized_keys' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'UsePAM no' 'AllowUsers voice' >"$root/sshd_config"
podman cp "$root/sshd_config" "$name-server:/work/sshd_config"
podman exec "$name-server" /usr/sbin/sshd -f /work/sshd_config -E /work/sshd.log
node --input-type=module - "$root/phone-input.mjs" <<'JS'
import ts from 'typescript';
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], ts.transpileModule(fs.readFileSync('src/phone-input.ts', 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
JS
podman exec "$name-server" mkdir -p /work/src
podman cp "$root/phone-input.mjs" "$name-server:/work/src/phone-input.mjs"
podman cp scripts/ssh-desktop/check.mjs "$name-server:/work/check.mjs"
podman cp scripts/ssh-desktop/client.sh "$name-client:/work/run.sh"
podman exec "$name-client" chown -R voice:voice /work
podman exec --user voice "$name-client" timeout 180 bash /work/run.sh
