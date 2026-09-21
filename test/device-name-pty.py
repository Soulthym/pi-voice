"""Offline controlling-terminal checks; no SSH, daemon, or user configuration."""
from concurrent.futures import ThreadPoolExecutor
import threading
import ctypes
import ctypes.util
import struct
import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import termios
import time


class Screen:
    """Real libvterm screen, not assertions over raw escape bytes."""
    class Rect(ctypes.Structure):
        _fields_ = [(name, ctypes.c_int) for name in ("top", "bottom", "left", "right")]

    def __init__(self):
        self.lib = ctypes.CDLL(ctypes.util.find_library("vterm") or "libvterm.so")
        for name, args, result in [
            ("vterm_new", [ctypes.c_int, ctypes.c_int], ctypes.c_void_p),
            ("vterm_set_utf8", [ctypes.c_void_p, ctypes.c_int], None),
            ("vterm_obtain_screen", [ctypes.c_void_p], ctypes.c_void_p),
            ("vterm_screen_reset", [ctypes.c_void_p, ctypes.c_int], None),
            ("vterm_input_write", [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t], ctypes.c_size_t),
            ("vterm_screen_get_text", [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, self.Rect], ctypes.c_size_t),
            ("vterm_free", [ctypes.c_void_p], None),
        ]:
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.term = self.lib.vterm_new(4, 40)
        self.lib.vterm_set_utf8(self.term, 1)
        self.screen = self.lib.vterm_obtain_screen(self.term)
        self.lib.vterm_screen_reset(self.screen, 1)
        self.feed(b"history\r\n" * 3)  # Prompt starts on the last row.

    def feed(self, data):
        self.lib.vterm_input_write(self.term, data, len(data))

    def lines(self):
        lines = []
        for row in range(4):
            buffer = ctypes.create_string_buffer(1024)
            size = self.lib.vterm_screen_get_text(self.screen, buffer, len(buffer), self.Rect(row, row + 1, 0, 40))
            lines.append(buffer.raw[:size].decode().rstrip())
        return lines

    def close(self):
        self.lib.vterm_free(self.term)


def terminal(wrapper, env, answer, expected=0, barrier=None, options=(), null_stdin=False, setter=False, preview=b"", screen_steps=()):
    screen = Screen() if screen_steps else None
    steps = list(screen_steps)
    pending_screen = None
    incoming, outgoing = os.pipe()
    os.write(outgoing, b"SSH stdin must survive\n")
    os.close(outgoing)
    pid, fd = pty.fork()
    if pid == 0:
        if screen:
            fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 4, 40, 0, 0))
        os.dup2(incoming, 0)
        os.close(incoming)
        if null_stdin:
            os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
        args = ["--set-device-name"] if setter else ["-F", env["TEST_SSH_CONFIG"], *options, "host"]
        os.execve("/bin/bash", ["bash", str(wrapper), *args], env)
    os.close(incoming)
    output = b""
    sent = False
    waited = False
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    chunk = os.read(fd, 4096)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output += chunk
                if screen:
                    screen.feed(chunk)
                if b"characters): " in output and not sent:
                    if barrier:
                        barrier.wait(timeout=5)
                    if screen:
                        data, pending_screen = steps.pop(0)
                        os.write(fd, data)
                    else:
                        os.write(fd, preview or answer)
                    sent = True
                if sent and preview and preview in output:
                    os.write(fd, answer)
                    preview = b""
            elif pending_screen is not None:
                lines = screen.lines()
                assert lines[-1] == pending_screen, lines
                assert lines[-2] == "Device name (1–128 characters):", lines
                if steps:
                    data, pending_screen = steps.pop(0)
                    os.write(fd, data)
                else:
                    pending_screen = None
                    os.write(fd, answer)
        else:
            raise AssertionError(("PTY wrapper hung", answer, output))
        _, status = os.waitpid(pid, 0)
        waited = True
        assert os.waitstatus_to_exitcode(status) in (expected if isinstance(expected, tuple) else (expected,)), output
        assert not steps and pending_screen is None, "screen checks must complete"
        assert termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ICANON) == (termios.ECHO | termios.ICANON), "prompt must restore the terminal"
        return output
    finally:
        if screen:
            screen.close()
        os.close(fd)
        if not waited:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


for wrapper in [Path("client/pi-voice-ssh").resolve(), Path("termux/pi-voice-ssh").resolve()]:
    with tempfile.TemporaryDirectory(prefix="voice-name-pty-") as root:
        root = Path(root)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        ssh = bin_dir / "ssh"
        ssh.write_text('#!/bin/bash\n[[ $1 == -G ]] || exit 99\ncat >"$HOME/stdin"\nexec /usr/bin/ssh "$@"\n')
        ssh.chmod(0o755)
        env = {**os.environ, "HOME": str(root), "XDG_CONFIG_HOME": str(root / "config"),
               "XDG_RUNTIME_DIR": str(root / "runtime"), "PI_VOICE_SSH_DRY_RUN": "1",
               "PATH": str(bin_dir) + ":/usr/bin:/bin", "LC_ALL": "C"}
        ssh_config = root / "ssh-config"
        ssh_config.write_text("")
        env["TEST_SSH_CONFIG"] = str(ssh_config)
        config = root / "config" / "pi-voice"
        name_file = config / "device-name"
        id_file = config / "device-id"
        def headless(*args, expected=0):
            result = subprocess.run(["bash", str(wrapper), *args], env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True,
                                    start_new_session=True, timeout=10)
            assert result.returncode == expected, (args, result)
            return result

        # A setter cannot even query SSH configuration or launch a helper.
        real_fake_ssh = ssh.read_text()
        ssh.write_text('#!/bin/sh\ntouch "$HOME/network-called"\nexit 99\n')
        for args in [("--set-device-name", "name", "host"),
                     ("--set-device-name", "--device-dir", "/remote"),
                     ("-v", "--set-device-name", "host"),
                     ("--", "--set-device-name"),
                     ("--set-device-name", "My device", "-v"),
                     ("--device-dir", "/remote", "--set-device-name", "host")]:
            headless(*args, expected=2)
            assert not config.exists(), args
        result = headless("--set-device-name", expected=2)
        assert b"controlling terminal" in result.stderr
        for name in ["", "   ", "bad\x1b[31m", "bad\u202e", "x" * 129, b"bad\xff"]:
            headless("--set-device-name", name, expected=2)
            assert not name_file.exists() and not id_file.exists()
        headless("--set-device-name", "My device")
        assert name_file.read_text() == "My device\n" and not id_file.exists()
        id_file.write_bytes(b"legacy ID exactly\n")
        headless("--set-device-name", "小明 café 😀")
        assert name_file.read_text() == "小明 café 😀\n"
        assert id_file.read_bytes() == b"legacy ID exactly\n"
        failed_mv = bin_dir / "mv"
        failed_mv.write_text('#!/bin/sh\necho "rename denied" >&2\nexit 1\n')
        failed_mv.chmod(0o755)
        headless("--set-device-name", "not saved", expected=1)
        assert name_file.read_text() == "小明 café 😀\n"
        assert id_file.read_bytes() == b"legacy ID exactly\n"
        assert not list(config.glob(".device-*"))
        failed_mv.unlink()
        # Bad rename destinations must not absorb a temp file or change identity.
        saved = config / "saved-name"
        name_file.rename(saved)
        for symlink in [False, True]:
            target = config / "directory"
            target.mkdir()
            if symlink:
                name_file.symlink_to(target, target_is_directory=True)
            else:
                target.rename(name_file)
            result = headless("--set-device-name", "not saved", expected=1)
            assert b"destination must be a regular file" in result.stderr
            assert not list((target if symlink else name_file).iterdir())
            assert not list(config.glob(".device-*"))
            assert saved.read_text() == "小明 café 😀\n"
            assert id_file.read_bytes() == b"legacy ID exactly\n"
            if symlink:
                name_file.unlink()
                target.rmdir()
            else:
                name_file.rmdir()
        saved.rename(name_file)
        # Last row, 40 columns: wrapping used to stale the saved absolute cursor.
        terminal(wrapper, env, b"\n", setter=True, screen_steps=[
            (b"abcdefghijklmno", "> abcdefghijklmno"),
            (b"\x7f", "> abcdefghijklmn"),
            (b"Z", "> abcdefghijklmnZ"),
            (b"x" * 40, "< " + "x" * 37),
            (b"\x7fY", "< " + "x" * 36 + "Y"),
        ])
        assert name_file.read_text() == "abcdefghijklmnZ" + "x" * 39 + "Y\n"
        terminal(wrapper, env, b"\n", setter=True, screen_steps=[
            (("界" * 25).encode(), "< " + "界" * 18),
            (b"\x7f", "< " + "界" * 18),
            ("明".encode(), "< " + "界" * 17 + "明"),
        ])
        assert name_file.read_text() == "界" * 24 + "明\n"
        terminal(wrapper, env, b"\n", setter=True, screen_steps=[
            ("小明 café 😀 é".encode(), "> 小明 café 😀 é"),
            (b"\x7f", "> 小明 café 😀 e"),
            (b"\x7f\x7f\x7f", "> 小明 café"),
            ("新".encode(), "> 小明 café 新"),
        ])
        assert name_file.read_text() == "小明 café 新\n"
        for unsafe in [b"\x1b[31m", "\u202e".encode(), b"\xff"]:
            terminal(wrapper, env, b"\n", expected=2, setter=True, screen_steps=[
                (b"safe", "> safe"), (unsafe, "> safe"),
            ])
            assert name_file.read_text() == "小明 café 新\n"
        terminal(wrapper, env, b" rename\n", setter=True, preview=b"visible")
        assert name_file.read_text() == "visible rename\n"
        for cancel in [b"\x03", b"\x04", b"bad\xc3\n", b"bad\xc3\x04"]:
            terminal(wrapper, env, cancel, (-signal.SIGINT, 2) if cancel == b"\x03" else 2, setter=True)
            assert name_file.read_text() == "visible rename\n"
            assert id_file.read_bytes() == b"legacy ID exactly\n"
        # Concurrent explicit renames replace complete files and retain identity.
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda name: headless("--set-device-name", name),
                          ["setter one", "setter two", "setter three", "setter four"]))
        assert name_file.read_text() in [n + "\n" for n in ["setter one", "setter two", "setter three", "setter four"]]
        assert id_file.read_bytes() == b"legacy ID exactly\n"
        assert not (root / "network-called").exists()
        assert not (root / "runtime").exists()
        name_file.unlink()
        id_file.unlink()
        ssh.write_text(real_fake_ssh)
        headless("--set-device-name", "remote semantics")
        headless("host", "remotecommand", "--set-device-name")
        assert name_file.read_text() == "remote semantics\n"
        name_file.unlink()
        id_file.unlink()
        for options in [("-oBatchMode=yes",), ("-o", "bAtChMoDe=YeS"), ()]:
            ssh_config.write_text("Host *\n  BatchMode yes\n" if not options else "")
            output = terminal(wrapper, env, b"", 2, options=options, null_stdin=True)
            assert b"characters): " not in output and b"--set-device-name" in output, output
            assert not name_file.exists() and not id_file.exists()
        # Explicit no takes precedence over config and leaves prompting available.
        output = terminal(wrapper, env, b"\x04", 2, options=("-oBatchMode=no",))
        assert b"characters): " in output, output
        ssh_config.write_text("")
        for locale in ["C", "C.UTF-8"]:
            for answer in [b"bad\xc3\n", b"bad\xc3\x04", b"bad\xc3\x03"]:
                output = terminal(wrapper, {**env, "LC_ALL": locale}, answer,
                                  (-signal.SIGINT, 2) if answer.endswith(b"\x03") else 2)
                assert not name_file.exists() and not id_file.exists()
        for answer in [b"\x04", b"\n", b"   \n", b"bad\x1b[31m\n", b"bad\0name\n", b"x" * 129 + b"\n", ("é" * 129 + "\n").encode(), ("😀" * 129 + "\n").encode()]:
            output = terminal(wrapper, env, answer, 2)
            assert b"Connected to" not in output and b"\x1b[31m" not in output, output
            assert not name_file.exists() and not id_file.exists()
        # Bash read may receive Ctrl-C as a byte rather than a terminal signal.
        output = terminal(wrapper, env, b"\x03", (-signal.SIGINT, 2))
        assert not name_file.exists() and not id_file.exists()
        # Hard links may be denied on Android; publication must not invoke ln.
        fake_ln = bin_dir / "ln"
        fake_ln.write_text('#!/bin/sh\necho "ln: Operation not permitted / unsupported -T" >&2\nexit 1\n')
        fake_ln.chmod(0o755)
        # At rename, destination is absent and the private source is complete.
        checked_mv = bin_dir / "mv"
        checked_mv.write_text('#!/bin/bash\n[[ ! -e $3 && $(stat -c %a "$2") == 600 && $(tail -c1 "$2" | od -An -tu1) == *10* ]] || exit 98\nexec /usr/bin/mv "$@"\n')
        checked_mv.chmod(0o755)
        # Both prompts are open before either answers: no prompt lock, first publish wins.
        barrier = threading.Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            runs = [pool.submit(terminal, wrapper, env, answer, 0, barrier)
                    for answer in [b"first name\n", b"second name\n"]]
            outputs = [run.result(timeout=15) for run in runs]
        assert name_file.read_text() in ["first name\n", "second name\n"]
        assert len({out.split(b"device=")[1].split()[0] for out in outputs}) == 1
        name_file.unlink()
        # Upgrades must retain an already provisioned stable ID byte-for-byte.
        id_file.write_text("12345678-1234-4234-8234-123456789abc\n")
        old_id = id_file.read_bytes()
        # A failing atomic rename reports the operation and OS reason, never input.
        fake_mv = bin_dir / "mv"
        fake_mv.write_text('#!/bin/sh\nprintf "rename: Permission denied\\033[31m\\n" >&2\nexit 1\n')
        fake_mv.chmod(0o755)
        output = terminal(wrapper, env, b"private name\n", 1)
        assert b"atomic rename" in output and b"Permission denied" in output, output
        assert b"private name" in output and b"\x1b[31m" not in output, output
        assert not name_file.exists() and id_file.read_bytes() == old_id
        assert not list(config.glob(".device-*"))
        # Signals immediately before rename leave no half-file or held lock.
        for sig in ["INT", "TERM"]:
            fake_mv.write_text('#!/bin/sh\nkill -' + sig + ' "$PPID"\nexit 1\n')
            terminal(wrapper, env, b"cancel save\n", 1)
            assert not name_file.exists() and id_file.read_bytes() == old_id
            assert not list(config.glob(".device-*"))
            subprocess.run(["flock", "-n", str(config / ".device.lock"), "true"], check=True)
        fake_mv.unlink()
        # Actual EACCES opening the publication fence, not a fake permissions error.
        if os.geteuid() != 0:
            fence = config / ".device.lock"
            fence.chmod(0o400)
            try:
                output = terminal(wrapper, env, b"private name\n", 1)
                assert b"open publication lock" in output and b"Permission denied" in output, output
                assert not name_file.exists() and id_file.read_bytes() == old_id
            finally:
                fence.chmod(0o600)
            # Directory becomes read-only after the parent's mkdir/chmod succeeds.
            fake_flock = bin_dir / "flock"
            fake_flock.write_text('#!/bin/sh\n/usr/bin/flock "$@" || exit $?\nchmod 500 "$XDG_CONFIG_HOME/pi-voice"\n')
            fake_flock.chmod(0o755)
            try:
                output = terminal(wrapper, env, b"private name\n", 1)
                assert b"create private temporary file" in output and b"Permission denied" in output, output
                assert not name_file.exists() and id_file.read_bytes() == old_id
            finally:
                config.chmod(0o700)
                fake_flock.unlink()
        # An occupied fence times out without creating a temporary/name file.
        with (config / ".device.lock").open("w") as fence:
            fcntl.flock(fence, fcntl.LOCK_EX)
            output = terminal(wrapper, env, b"waiting name\n", 1)
            assert b"acquire publication lock (5 seconds" in output, output
            assert not name_file.exists() and id_file.read_bytes() == old_id
            assert not list(config.glob(".device-*"))
        name = '小明 "phone" \\ café 😀'
        for valid in ["😀" * 128, "é" * 128]:
            terminal(wrapper, env, (valid + "\n").encode())
            assert name_file.read_text() == valid + "\n"
            name_file.unlink()
        output = terminal(wrapper, env, (name + "é\x7f😀\x08\n").encode())
        assert name.encode() in output and b'\r\x1b[2K' in output, output
        assert name_file.read_text() == name + "\n"
        assert id_file.read_bytes() == old_id
        output = terminal(wrapper, env, b"renamed visibly\n", setter=True)
        assert b"renamed visibly" in output
        assert name_file.read_text() == "renamed visibly\n" and id_file.read_bytes() == old_id
        terminal(wrapper, env, (name + "\n").encode(), setter=True)
        assert (root / "stdin").read_bytes() == b"SSH stdin must survive\n"
        output = terminal(wrapper, env, b"unused\n")
        assert b"Device name (" not in output
        assert name_file.read_text() == name + "\n"
        assert config.stat().st_mode & 0o777 == 0o700
        assert all(p.stat().st_mode & 0o777 == 0o600 for p in [name_file, id_file])
        # Simultaneous ID creation reads a single atomically published winner.
        id_file.unlink()
        runs = [subprocess.Popen(["bash", str(wrapper), "host"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                for _ in range(12)]
        outputs = [run.communicate(timeout=10) for run in runs]
        assert all(run.returncode == 0 for run in runs), outputs
        ids = {out.split()[0] for out, _ in outputs}
        assert len(ids) == 1, ids
        assert name_file.read_text() == name + "\n"
        # Clear configuration error rather than a prompt/connection on read-only config.
        readonly = subprocess.run(["bash", str(wrapper), "host"],
                                  env={**env, "XDG_CONFIG_HOME": "/proc/pi-voice-test-readonly"},
                                  stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
                                  start_new_session=True)
        assert readonly.returncode == 1 and b"configuration" in readonly.stderr
# Keep shared identity handling byte-identical despite platform-specific tails.
client = Path("client/pi-voice-ssh").read_text()
termux = Path("termux/pi-voice-ssh").read_text()
assert client.split("runtime_root=", 1)[1].split("mkdir -p \"$runtime_root\"", 1)[0] == termux.split("runtime_root=", 1)[1].split("mkdir -p \"$runtime_root\"", 1)[0]
print("PASS: both wrappers PTY hardlink denial/atomic save/errors/signals/lock timeout/permissions/legacy ID/concurrency and prompt validation")
