#!/usr/bin/env python3
"""Single-purpose, fail-closed binding-v4 pidfd proof. Never sends signals."""
import ctypes
import errno
import os
import re
import select
import stat
import sys

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def require(condition):
    if not condition:
        raise ValueError("unproven")


def read(path, limit=1048576):
    with open(path, "rb") as stream:
        value = stream.read(limit + 1)
    require(len(value) <= limit and b"\0" not in value)
    # Unrelated mount paths and process comm fields may contain arbitrary bytes.
    # Identity tokens are separately restricted by their ASCII patterns.
    return value.decode("ascii", "surrogateescape")


def trusted_proc():
    mounts = read("/proc/self/mountinfo")
    require(mounts.endswith("\n"))
    seen = set()
    device = None
    for line in mounts.splitlines():
        left, right = line.split(" - ")
        fields, extra = left.split(), right.split()
        require(len(fields) >= 6 and len(extra) == 3)
        require(re.fullmatch(r"[0-9]+", fields[0]) and
                re.fullmatch(r"[0-9]+", fields[1]) and
                re.fullmatch(r"[0-9]+:[0-9]+", fields[2]))
        dev, root, mount, options = fields[2:6]
        if mount in ("/proc", "/proc/sys", "/proc/sys/kernel",
                     "/proc/sys/kernel/random", "/proc/sys/kernel/random/boot_id"):
            require(extra[0] == "proc" and mount not in seen and
                    (device is None or device == dev))
            require(root == ("/" if mount == "/proc" else mount[5:]))
            for option in (options + "," + extra[2]).split(","):
                require(not option.startswith("hidepid=") or
                        option in ("hidepid=0", "hidepid=1", "hidepid=2"))
            seen.add(mount)
            device = dev
        elif mount.startswith("/proc/"):
            first = mount.split("/")[2]
            require(first not in ("self", "thread-self", "mounts") and
                    not first.isdigit() and "\\" not in mount)
    require("/proc" in seen)


def namespaces():
    release = os.uname().release
    match = re.fullmatch(r"([0-9]{1,3})\.([0-9]{1,3})\.[0-9]{1,6}([-+._a-zA-Z][-+._a-zA-Z0-9]*)?", release)
    require(len(release) <= 64 and match is not None)
    # listdir must finish successfully: failed readlink does not prove absence.
    names = os.listdir("/proc/self/ns")
    require(sum(len(name) + 1 for name in names) <= 4096 and
            len(set(names)) == len(names) and "mnt" in names and
            all(re.fullmatch(r"[a-z][a-z0-9_]{0,63}", name) for name in names))
    values = []
    for name in ("pid", "mnt", "time"):
        if name in names:
            value = os.readlink("/proc/self/ns/" + name)
            require(re.fullmatch(name + r":\[[0-9]{1,20}\]", value))
        elif name == "pid":
            value = "unsupported-no-pid"
        else:
            require(name == "time" and tuple(map(int, match.group(1, 2))) < (5, 6))
            value = "unsupported-pre5.6"
        values.append(value)
    return tuple(values)


def ticks(path, pid):
    value = read(path)
    head, tail = value.rsplit(") ", 1)
    require(head.startswith(str(pid) + " (") and len(tail.split()) >= 20)
    value = tail.split()[19]
    require(re.fullmatch(r"[0-9]{1,20}", value))
    return value


def pidfd_open(pid):
    native = getattr(os, "pidfd_open", None)
    if native is not None:
        return native(pid, 0)
    # Android may expose libc's wrapper even when Python does not expose it.
    native = ctypes.CDLL(None, use_errno=True).pidfd_open
    native.argtypes = (ctypes.c_int, ctypes.c_uint)
    native.restype = ctypes.c_int
    fd = native(pid, 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "pidfd unavailable")
    return fd


def exited(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    events = poll.poll(0)
    require(all(number == fd and flags & select.POLLIN and
                not flags & ~(select.POLLIN | select.POLLHUP) for number, flags in events))
    return bool(events)


def domain():
    trusted_proc()
    ticks("/proc/self/stat", os.getpid())
    require(os.getuid() == os.geteuid())
    uid = re.search(r"\nUid:\s+([0-9]{1,10})\s", read("/proc/self/status"))
    require(uid is not None and int(uid[1]) == os.getuid())
    boot = read("/proc/sys/kernel/random/boot_id", 37)
    require(re.fullmatch(UUID + r"\n?", boot))
    return boot.rstrip("\n"), str(os.getuid()), namespaces()


def probe_pidfd():
    fd = pidfd_open(os.getpid())
    try:
        require(not exited(fd))
    finally:
        os.close(fd)


def binding(path):
    parent, name = os.path.split(os.path.abspath(path))
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                    info.st_mode & 0o077 == 0 and info.st_nlink == 1)
            value = stream.read(1025)
    finally:
        os.close(directory)
    require(len(value) <= 1024 and b"\0" not in value)
    text = value.decode("ascii")
    require(text.endswith("\n") and text.count("\n") == 1)
    fields = text[:-1].split(" ")
    require(len(fields) == 9)
    scope, boot, pid, start, uid, pidns, mntns, version, timens = fields
    require(re.fullmatch(UUID, scope) and scope == os.path.basename(parent) and
            re.fullmatch(UUID, boot) and re.fullmatch(r"[1-9][0-9]{0,9}", pid) and
            int(pid) <= 2147483647 and re.fullmatch(r"[0-9]{1,20}", start) and
            re.fullmatch(r"[0-9]{1,10}", uid) and version == "binding-v4")
    return boot, uid, (pidns, mntns, timens), int(pid), start


def prove(command, path=None):
    if command == "probe":
        domain()
        probe_pidfd()
        return True
    boot, uid, ns, pid, start = binding(path)
    require(domain() == (boot, uid, ns))
    # Capability must be positively established before ESRCH is evidence.
    probe_pidfd()
    try:
        fd = pidfd_open(pid)
    except OSError as error:
        if command == "gone" and error.errno == errno.ESRCH:
            return True
        raise
    try:
        if exited(fd):
            return command == "gone"
        current = ticks("/proc/%d/stat" % pid, pid)
        if command == "gone":
            return current != start
        return current == start and not exited(fd)
    finally:
        os.close(fd)


def main(args):
    try:
        require(args == ["probe"] or
                (len(args) == 2 and args[0] in ("gone", "validate")))
        require(prove(*args))
        return 0
    except (OSError, ValueError, AttributeError, OverflowError):
        print("Pi Voice native proof: unproven", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
