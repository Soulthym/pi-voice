"""Run with python3 -m unittest discover -s test -p test_native_proof.py."""
import contextlib
import ctypes
import errno
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("proof", ROOT / "client/pi-voice-native-proof.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
SCOPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
BOOT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def proc_stat(pid, start="222"):
    return str(pid) + " (native (name)) S " + "0 " * 18 + start + "\n"


class NativeProof(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / SCOPE
        self.directory.mkdir(mode=0o700)
        self.path = self.directory / "bound"
        self.ns = ("unsupported-no-pid", "mnt:[123]", "unsupported-pre5.6")
        self.save()

    def save(self, **changes):
        fields = [SCOPE, BOOT, "424242", "222", str(os.getuid()), *self.ns[:2], "binding-v4", self.ns[2]]
        for key, value in changes.items():
            fields[int(key)] = value
        self.path.write_text(" ".join(fields) + "\n")
        self.path.chmod(0o600)

    @contextlib.contextmanager
    def android(self, target=None, hidden=False):
        calls = []
        def read(path, limit=1048576):
            if path == "/proc/self/mountinfo":
                return "1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n"
            if path == "/proc/self/stat":
                return proc_stat(os.getpid())
            if path == "/proc/self/status":
                return "Name: proof\nUid:\t%d\t%d\t%d\t%d\n" % ((os.getuid(),) * 4)
            if path == "/proc/sys/kernel/random/boot_id":
                return BOOT + "\n"
            if path == "/proc/424242/stat":
                if hidden:
                    raise OSError(hidden, "hidden")
                return proc_stat(424242)
            raise PermissionError(errno.EACCES, "osrelease denied")
        class Libc:
            class Open:
                def __call__(self, pid, flags):
                    calls.append(pid)
                    if pid == 424242 and target is not None:
                        ctypes.set_errno(target)
                        return -1
                    return 71
            pidfd_open = Open()
        libc = Libc()
        with contextlib.ExitStack() as stack:
            # Exact Android combination: Python lacks pidfd_open; libc provides it.
            if hasattr(os, "pidfd_open"):
                original = os.pidfd_open
                del os.pidfd_open
                stack.callback(setattr, os, "pidfd_open", original)
            stack.enter_context(patch.object(p.ctypes, "CDLL", return_value=libc))
            stack.enter_context(patch.object(p, "read", side_effect=read))
            stack.enter_context(patch.object(p.os, "uname", return_value=types.SimpleNamespace(release="5.4.210-android")))
            stack.enter_context(patch.object(p.os, "listdir", return_value=["cgroup", "mnt", "net", "uts"]))
            stack.enter_context(patch.object(p.os, "readlink", side_effect=lambda path: "mnt:[123]" if path.endswith("/mnt") else self.fail("absent namespace read")))
            stack.enter_context(patch.object(p, "exited", return_value=False))
            close = stack.enter_context(patch.object(p.os, "close"))
            # Real binding I/O needs real close; only synthetic pidfds are ignored.
            close.side_effect = lambda fd: real_close(fd) if fd != 71 else None
            yield calls, libc

    def test_android_and_errno(self):
        for error, expected in ((errno.ESRCH, 0), (errno.EPERM, 1), (errno.EACCES, 1), (errno.ENOSYS, 1)):
            with self.subTest(error=error), self.android(target=error) as (calls, libc):
                self.assertEqual(self.run_cli("probe"), 0)
                self.assertEqual(self.run_cli("gone", str(self.path)), expected)
                self.assertEqual(calls, [os.getpid(), os.getpid(), 424242])
                self.assertEqual(libc.pidfd_open.argtypes, (ctypes.c_int, ctypes.c_uint))
                self.assertIs(libc.pidfd_open.restype, ctypes.c_int)
        with self.android():
            self.assertEqual(self.run_cli("validate", str(self.path)), 0)
            self.assertEqual(self.run_cli("gone", str(self.path)), 1)
        for error in (errno.ENOENT, errno.EACCES):
            with self.android(hidden=error):
                self.assertEqual(self.run_cli("gone", str(self.path)), 1)
                self.assertEqual(self.run_cli("validate", str(self.path)), 1)
                self.save(**{"3": "333"})
                self.assertEqual(self.run_cli("gone", str(self.path)), 1)
                self.save()

    def run_cli(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            result = p.main(list(args))
        self.assertEqual(output.getvalue(), "" if result == 0 else "Pi Voice native proof: unproven\n")
        return result

    def test_fences_before_pidfd_and_reuse(self):
        for index, value in (("1", SCOPE), ("4", "999999"), ("5", "pid:[9]"),
                             ("6", "mnt:[9]"), ("7", "binding-v3"), ("8", "time:[9]")):
            self.save(**{index: value})
            with self.android(target=errno.ESRCH) as (calls, _):
                self.assertEqual(self.run_cli("gone", str(self.path)), 1)
                self.assertEqual(calls, [])
        self.save(**{"3": "333"})
        with self.android():
            self.assertEqual(self.run_cli("gone", str(self.path)), 0)
            self.assertEqual(self.run_cli("validate", str(self.path)), 1)

    def test_namespace_absence_requires_complete_listing_and_old_kernel(self):
        for name, kwargs in (("listdir", {"side_effect": PermissionError()}),
                             ("listdir", {"return_value": ["mnt", "pid"]}),
                             ("uname", {"return_value": types.SimpleNamespace(release="5.6.0")})):
            with self.android() as (calls, _), patch.object(p.os, name, **kwargs), patch.object(p.os, "readlink", side_effect=PermissionError()):
                self.assertEqual(self.run_cli("gone", str(self.path)), 1)
                self.assertEqual(calls, [])

    def test_positive_capability_and_alignment(self):
        with self.android() as (calls, _), patch.object(p, "pidfd_open", side_effect=ProcessLookupError(errno.ESRCH, "missing")):
            self.assertEqual(self.run_cli("gone", str(self.path)), 1)
        with self.android() as (calls, _), patch.object(p.os, "getpid", return_value=123), patch.object(p, "ticks", side_effect=ValueError()):
            self.assertEqual(self.run_cli("probe"), 1)
            self.assertEqual(calls, [])
        with self.android() as (calls, _), patch.object(p, "exited", side_effect=[False, True]):
            self.assertEqual(self.run_cli("gone", str(self.path)), 0)
        with patch.object(p.os, "pidfd_open", return_value=99, create=True) as native, patch.object(p.ctypes, "CDLL") as libc:
            self.assertEqual(p.pidfd_open(123), 99)
            native.assert_called_once_with(123, 0)
            libc.assert_not_called()

    def test_simulated_foreign_proc_view_rejects_native_pid_mismatch(self):
        with self.android() as (calls, _):
            original_read = p.read
            def foreign_view(path, limit=1048576):
                return proc_stat(os.getpid() + 1) if path == "/proc/self/stat" else original_read(path, limit)
            with patch.object(p, "read", side_effect=foreign_view):
                self.assertEqual(self.run_cli("probe"), 1)
                self.assertEqual(self.run_cli("gone", str(self.path)), 1)
                self.assertEqual(calls, [])

    def test_private_bounded_binding(self):
        original = self.path.read_bytes()
        for value in (original + b"\n", original + b"x" * 1024, original.replace(b"binding-v4", b"binding-v4\0")):
            self.path.write_bytes(value)
            self.assertEqual(self.run_cli("gone", str(self.path)), 1)
        self.path.write_bytes(original)
        self.path.chmod(0o644)
        self.assertEqual(self.run_cli("gone", str(self.path)), 1)
        self.path.chmod(0o600)
        alias = self.directory / "alias"
        alias.symlink_to(self.path)
        self.assertEqual(self.run_cli("gone", str(alias)), 1)
        self.directory.chmod(0o755)
        self.assertEqual(self.run_cli("gone", str(self.path)), 1)

    def test_mount_fences(self):
        good = "1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n"
        for suffix in ("2 1 0:2 / /proc/424242 rw - tmpfs tmpfs rw\n",
                       "2 1 0:2 / /proc/sys/kernel/random/boot_id rw - tmpfs tmpfs rw\n"):
            with self.android() as (calls, _), patch.object(p, "read", return_value=good + suffix):
                self.assertEqual(self.run_cli("gone", str(self.path)), 1)
                self.assertEqual(calls, [])

    def test_non_ascii_unrelated_mount(self):
        value = b"1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n2 1 0:2 / /media/caf\xc3\xa9 rw - tmpfs tmpfs rw\n"
        with patch("builtins.open", return_value=io.BytesIO(value)):
            p.trusted_proc()

    def test_real_linux_pidfd(self):
        try:
            fd = p.pidfd_open(os.getpid())
        except (OSError, AttributeError) as error:
            self.skipTest(str(error))
        try:
            self.assertFalse(p.exited(fd))
        finally:
            os.close(fd)
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        try:
            fd = p.pidfd_open(child.pid)
            child.wait(timeout=5)
            try:
                self.assertTrue(p.exited(fd))
            finally:
                os.close(fd)
        finally:
            child.wait(timeout=5)
        # Run the complete contract only where the actual mount layout is trusted.
        if self.run_cli("probe") == 0:
            boot, uid, ns = p.domain()
            self.ns = ns
            self.save(**{"1": boot, "2": str(os.getpid()), "3": p.ticks("/proc/self/stat", os.getpid()), "4": uid})
            self.assertEqual(self.run_cli("validate", str(self.path)), 0)
            self.assertEqual(self.run_cli("gone", str(self.path)), 1)

    def test_copies(self):
        self.assertEqual((ROOT / "client/pi-voice-native-proof.py").read_bytes(),
                         (ROOT / "termux/pi-voice-native-proof.py").read_bytes())


real_close = os.close

if __name__ == "__main__":
    unittest.main()
