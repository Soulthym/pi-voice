#!/usr/bin/env bash
set -euo pipefail
export XDG_RUNTIME_DIR=/work/runtime PULSE_SERVER=unix:/work/runtime/pulse/native
export DBUS_SESSION_BUS_ADDRESS=unix:path=/work/runtime/bus
export PI_VOICE_CLIENT_COMMAND=/work/client/pi-voice-client PI_VOICE_MAX_RECORD_SECONDS=3
# Client-only ephemeral persisted identity; the SSH server has no name config.
mkdir -m 700 -p "$XDG_RUNTIME_DIR" /work/bin /work/device-config/pi-voice
(umask 077; printf '%s\n' 'Synthetic desktop client' >/work/device-config/pi-voice/device-name)
# No player may open speakers. Protocol hello should not even invoke this stub.
printf '#!/bin/sh\ntouch /work/player-called\nexit 1\n' >/work/bin/mpv
chmod +x /work/bin/mpv
export PATH=/work/bin:$PATH
env -u PULSE_SERVER pulseaudio --start --exit-idle-time=-1 --load='module-null-sink sink_name=test'
# A genuine source, NOT a sink monitor; no hardware devices exist in this container.
ffmpeg -v error -f lavfi -i 'sine=frequency=440:sample_rate=16000' -t 15 -f s16le /work/sine.pcm
pactl load-module module-pipe-source source_name=synthetic file=/work/mic format=s16le rate=16000 channels=1 >/dev/null
pactl set-default-source synthetic
ffmpeg -v error -re -stream_loop -1 -f s16le -ar 16000 -ac 1 -i /work/sine.pcm -f s16le - >/work/mic &
feed=$!
printf 'Versions: '; parec --version; pw-record --version
printf 'PipeWire raw option advertised: '; if pw-record --help 2>&1 | grep -- '--raw'; then :; else echo no; fi
ssh_run() {
 XDG_CONFIG_HOME=/work/device-config /work/client/pi-voice-ssh -F /dev/null -i /work/key -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/work/known_hosts voice@127.0.0.1 node /work/check.mjs "$1"
}
ssh_run pulse
ssh_run pulse-stop
ssh_run pulse-cancel
ssh_run route-gone
# A concurrent wrapper shares the existing bridge's launch environment.
ssh_run hold >/work/hold.log 2>&1 &
hold=$!
for _ in {1..100}; do
  [[ -s /work/runtime/pi-voice-ssh-$(id -u)/client-bridge.pid ]] && break
  sleep 0.05
done
PULSE_SERVER=unix:/work/missing ssh_run drift
wait "$hold"
pactl set-default-source test.monitor
ssh_run monitor
pactl set-default-source synthetic
kill "$feed" 2>/dev/null || true
wait "$feed" 2>/dev/null || true
env -u PULSE_SERVER pulseaudio --kill
ssh_run unavailable
[[ ! -e /work/player-called ]]
echo 'PASS: no speaker/player invocation'

# A private PipeWire graph with a synthetic source, no ALSA/device access.
unset PULSE_SERVER
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS"
mkdir -p /home/voice/.config/pipewire/pipewire.conf.d
printf '%s\n' 'context.spa-libs = { audiotestsrc = audiotestsrc/libspa-audiotestsrc }' 'context.objects = [ { factory = adapter args = { factory.name = audiotestsrc node.name = synthetic-pw media.class = Audio/Source audio.position = [ MONO ] } } ]' >/home/voice/.config/pipewire/pipewire.conf.d/test.conf
pipewire >/work/pipewire.log 2>&1 &
wireplumber >/work/wireplumber.log 2>&1 &
for _ in {1..100}; do
  wpctl get-volume @DEFAULT_AUDIO_SOURCE@ 2>/dev/null | grep -q '^Volume:' && break
  sleep 0.1
done
wpctl get-volume @DEFAULT_AUDIO_SOURCE@ | grep '^Volume:'
ssh_run pipewire
# Selection falls back to Pulse when the requested PipeWire daemon is absent;
# both unavailable must error, not capture on the server or another device.
PIPEWIRE_REMOTE=missing PULSE_SERVER=unix:/work/missing ssh_run unavailable-env
# Real SSH plus real encoder/decoder; only these source failures are injected.
for mode in natural-eof empty startup-failed; do
  if [[ $mode == natural-eof ]]; then
    printf '#!/bin/sh\n[ "$1" = --help ] && { echo "Usage: pw-record"; exit 0; }\ncat /work/sine.pcm\n' >/work/bin/pw-record
  else
    printf '#!/bin/sh\n[ "$1" = --help ] && { echo "Usage: pw-record"; exit 0; }\nexit %s\n' "$([[ $mode == empty ]] && echo 0 || echo 1)" >/work/bin/pw-record
  fi
  chmod +x /work/bin/pw-record
  ssh_run "$mode"
done
rm /work/bin/pw-record
[[ ! -e /work/player-called ]]
echo 'PASS: no speaker/player invocation (all cases)'
