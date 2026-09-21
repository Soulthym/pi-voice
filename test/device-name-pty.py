"""Offline controlling-terminal checks; no SSH, daemon, or user configuration."""
from concurrent.futures import ThreadPoolExecutor
import threading
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


def terminal(wrapper, env, answer, expected=0, barrier=None, options=(), null_stdin=False):
    incoming, outgoing = os.pipe()
    os.write(outgoing, b"SSH stdin must survive\n")
    os.close(outgoing)
    pid, fd = pty.fork()
    if pid == 0:
        os.dup2(incoming, 0)
        os.close(incoming)
        if null_stdin:
            os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
        os.execve("/bin/bash", ["bash", str(wrapper), "-F", env["TEST_SSH_CONFIG"], *options, "host"], env)
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
                if b"input hidden): " in output and not sent:
                    if barrier:
                        barrier.wait(timeout=5)
                    os.write(fd, answer)
                    sent = True
        else:
            raise AssertionError(("PTY wrapper hung", answer, output))
        _, status = os.waitpid(pid, 0)
        waited = True
        assert os.waitstatus_to_exitcode(status) in (expected if isinstance(expected, tuple) else (expected,)), output
        assert termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ICANON) == (termios.ECHO | termios.ICANON), "prompt must restore the terminal"
        return output
    finally:
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
        for options in [("-oBatchMode=yes",), ("-o", "bAtChMoDe=YeS"), ()]:
            ssh_config.write_text("Host *\n  BatchMode yes\n" if not options else "")
            output = terminal(wrapper, env, b"", 2, options=options, null_stdin=True)
            assert b"input hidden" not in output and b"device-name (mode 600" in output, output
            assert not name_file.exists() and not id_file.exists()
        # Explicit no takes precedence over config and leaves prompting available.
        output = terminal(wrapper, env, b"\x04", 2, options=("-oBatchMode=no",))
        assert b"input hidden" in output, output
        ssh_config.write_text("")
        for locale in ["C", "C.UTF-8"]:
            for answer in [b"bad\xc3\n", b"bad\xc3\x04", b"bad\xc3\x03"]:
                output = terminal(wrapper, {**env, "LC_ALL": locale}, answer,
                                  (-signal.SIGINT, 2) if answer.endswith(b"\x03") else 2)
                assert not name_file.exists() and not id_file.exists()
        for answer in [b"\x04", b"\n", b"   \n", b"bad\x1b[31m\n", b"bad\0name\n", b"x" * 129 + b"\n", ("é" * 129 + "\n").encode(), ("😀" * 129 + "\n").encode()]:
            output = terminal(wrapper, env, answer, 2)
            assert b"Connected to" not in output and b"\x1b" not in output, output
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
        assert b"private name" not in output and b"\x1b" not in output, output
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
        assert name_file.read_text() == name + "\n"
        assert id_file.read_bytes() == old_id
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
