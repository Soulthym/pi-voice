#!/usr/bin/env bash
# No Android API or inference: only prepare/cancel and mocked kernel boot reads.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" TMPDIR="$root/tmp"
mkdir -p "$HOME" "$XDG_CONFIG_HOME/pi-voice" "$TMPDIR" "$root/bin"
export REAL_CAT=$(command -v cat)
export MOCK_BOOT=11111111-1111-4111-8111-111111111111
old_boot=22222222-2222-4222-8222-222222222222
cat >"$root/bin/cat" <<'MOCK'
#!/usr/bin/env bash
if [[ ${1:-} == /proc/sys/kernel/random/boot_id ]]; then
  printf '%s\n' "$MOCK_BOOT"
else
  exec "$REAL_CAT" "$@"
fi
MOCK
cat >"$root/bin/termux-microphone-record" <<'MOCK'
#!/usr/bin/env bash
exit 99
MOCK
chmod +x "$root/bin/"*
export PATH="$root/bin:$PATH"
identity="$XDG_CONFIG_HOME/pi-voice/device-id"
fail() { printf '%s\n' "$*" >&2; exit 1; }
run() { printf '%s\n' "$1" | bash "$script" 2>/dev/null || true; }
message() { local response; response=$(run "$1"); [[ $response == 'ok '* ]] || fail "Expected OK: $response"; printf '%s' "${response#ok }" | base64 -d; }
reject() { local response; response=$(run "$1"); [[ $response != 'ok '* ]] || fail "Unexpected proof: $response"; }
cmp termux/pi-voice-stt-session client/pi-voice-termux-stt-session
for script in termux/pi-voice-stt-session client/pi-voice-termux-stt-session; do
  rm -rf "$XDG_STATE_HOME"
  printf 'phone_1.example-2\n' >"$identity"
  read -r kind ticket boot capability device extra <<<"$(run ticket-admit)"
  [[ $kind == ticket && $boot == "$MOCK_BOOT" && $capability == admit-v1 && $device == phone_1.example-2 && -z $extra ]] || fail 'Prepare contract'
  [[ $(message "stop-admit $ticket $boot $device") == "stopped $ticket" ]] || fail 'Same-boot exact receipt'
  [[ $(message "stop $ticket") == "stopped $ticket" ]] || fail 'Custom-host plain stop'
  [[ $(message "stop-admit $ticket $old_boot $device") == "stopped-reboot $ticket $old_boot $boot $device" ]] || fail 'Reboot receipt'
  reject "stop-admit $ticket $old_boot another-phone"
  reject "stop-admit $ticket invalid $device"
  reject "stop-admit $ticket $old_boot $device extra"
  reject "stop-admit $ticket $old_boot"
  reject "stop-admit invalid $old_boot $device"
  reject "stop-admit ${ticket%%.*}.9007199254740992 $old_boot $device"
  reject "stop-admit ${ticket%%.*}.0 $old_boot $device"
  reject "stop-admit ${ticket%%.*}.999 $boot $device"
  # Lost ticket storage is not needed for a different-boot, same-device proof.
  rm -rf "$XDG_STATE_HOME"
  [[ $(message "stop-admit $ticket $old_boot $device") == "stopped-reboot $ticket $old_boot $boot $device" ]] || fail 'Lost-state reboot receipt'
  reject "stop-admit $ticket $boot $device"
  saved_boot=$MOCK_BOOT
  export MOCK_BOOT=invalid
  reject "stop-admit $ticket $old_boot $device"
  export MOCK_BOOT=$saved_boot
  for bad in missing empty nul multiline spaces oversized; do
    case $bad in
      missing) rm -f "$identity" ;;
      empty) : >"$identity" ;;
      nul) printf 'phone\0suffix' >"$identity" ;;
      multiline) printf 'phone\n\n' >"$identity" ;;
      spaces) printf 'phone other' >"$identity" ;;
      oversized) printf '%129s' '' | tr ' ' a >"$identity" ;;
    esac
    [[ $(run ticket-admit) == *' admit-v1 null' ]] || fail "Invalid identity accepted: $bad"
    reject "stop-admit $ticket $old_boot $device"
    reject "stop-admit $ticket $old_boot null"
  done
  printf 'phone-no-newline' >"$identity"
  [[ $(run ticket-admit) == *' admit-v1 phone-no-newline' ]] || fail 'Optional final newline'
  read -r kind ticket boot extra <<<"$(run ticket)"
  [[ $kind == ticket && $boot == "$MOCK_BOOT" && -z $extra ]] || fail 'Legacy prepare contract'
done
printf 'Termux reboot proof checks passed\n'
