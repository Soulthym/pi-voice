// Synthetic Android/Linux capability model, NOT Android hardware validation.
export const trustedMounts = '1 0 0:1 / /proc rw,nosuid,nodev,noexec - proc proc rw\n';
export const namespaceCases = [
 'modern', 'old-present', 'old-absent', 'android', 'old-time-denied', 'old-pid-denied', 'old-list-error', 'pid-denied', 'mnt-denied',
 'time-denied', 'list-error', 'missing-mnt', 'modern-absent', 'uname-error',
 'release-malformed', 'release-nul', 'release-newline', 'release-long',
 'list-empty', 'list-duplicate', 'list-malformed', 'list-nul', 'list-no-newline',
 'list-blank', 'list-long', 'link-malformed', 'link-nul', 'link-long',
 'mount-question', 'mount-question-nul', 'mount-question-malformed', 'mount-empty',
 'mount-error', 'mount-malformed', 'mount-no-newline', 'mount-nul', 'mount-duplicate', 'mount-long', 'mount-nul-prefix',
 'mount-binfmt', 'mount-sys', 'mount-ancestry', 'mount-ancestry-reversed', 'mount-other-device', 'mount-wrong-root',
 'mount-sys-tmpfs', 'mount-sys-duplicate', 'mount-sys-hidepid', 'mount-ancestry-overlay',
 'mount-random-other-device', 'mount-boot-wrong-root',
 'hidepid', 'hidepid-super', 'mount-subroot', 'mount-not-proc',
 'overlay-self', 'overlay-pid', 'overlay-sys', 'overlay-thread-self', 'overlay-mounts', 'overlay-escaped',
] as const;

export function namespaceFixture(mode: string, pidfd = false) {
 const old = mode === 'android' || mode.startsWith('old-');
 let release = old ? '5.4.0-vendor\n' : '6.8.0\n';
 let listing = mode === 'android' ? 'mnt\nnet\nuser\nuts\n' : 'pid\nmnt\ntime\n';
 if (mode === 'old-absent' || mode === 'modern-absent') listing = 'pid\nmnt\n';
 if (mode === 'missing-mnt') listing = 'pid\ntime\n';
 if (mode === 'list-empty') listing = '';
 if (mode === 'list-duplicate') listing += 'mnt\n';
 if (mode === 'list-malformed') listing += '../pid\n';
 if (mode === 'list-nul') listing += 'bad\0name\n';
 if (mode === 'list-no-newline') listing = listing.trimEnd();
 if (mode === 'list-blank') listing += '\n';
 if (mode === 'list-long') listing += 'a'.repeat(4096) + '\n';
 if (mode === 'release-malformed') release = '5.4.vendor\n';
 if (mode === 'release-nul') release = '5.4.0\0-vendor\n';
 if (mode === 'release-newline') release += '\n';
 if (mode === 'release-long') release = '5.4.0-' + 'a'.repeat(65) + '\n';
 let mounts = trustedMounts;
 if (mode.startsWith('mount-question')) mounts += '2 1 0:2 / /media/backup? rw - tmpfs tmpfs rw\n';
 if (mode === 'mount-question-nul') mounts = mounts.replace('backup?', 'backup\0');
 if (mode === 'mount-question-malformed') mounts += 'broken\n';
 if (mode === 'mount-empty') mounts = '';
 if (mode === 'mount-malformed') mounts += 'broken\n';
 if (mode === 'mount-no-newline') mounts = mounts.trimEnd();
 if (mode === 'mount-nul') mounts += '\0';
 if (mode === 'mount-duplicate') mounts += trustedMounts;
 if (mode === 'mount-long') mounts += 'a'.repeat(1048576) + '\n';
 if (mode === 'mount-nul-prefix') mounts = mounts.replace('rw,nosuid', 'rw,\0nosuid');
 const sys = '2 1 0:1 /sys /proc/sys ro - proc proc rw\n';
 const ancestry = sys + '3 2 0:1 /sys/kernel /proc/sys/kernel ro - proc proc rw\n' +
  '4 3 0:1 /sys/kernel/random /proc/sys/kernel/random ro - proc proc rw\n' +
  '5 4 0:1 /sys/kernel/random/boot_id /proc/sys/kernel/random/boot_id ro - proc proc rw\n';
 if (mode === 'mount-binfmt') mounts += '2 1 0:2 / /proc/sys/kernel/binfmt_misc rw - binfmt_misc binfmt_misc rw\n';
 if (mode === 'mount-sys') mounts += sys;
 if (mode === 'mount-ancestry') mounts += ancestry;
 if (mode === 'mount-ancestry-reversed') mounts = ancestry.trimEnd().split('\n').reverse().join('\n') + '\n' + mounts;
 if (mode === 'mount-other-device') mounts += sys.replace('0:1', '0:2');
 if (mode === 'mount-wrong-root') mounts += sys.replace('/sys /proc', '/elsewhere /proc');
 if (mode === 'mount-sys-tmpfs') mounts += sys.replace('- proc proc', '- tmpfs tmpfs');
 if (mode === 'mount-sys-duplicate') mounts += sys + sys;
 if (mode === 'mount-sys-hidepid') mounts += sys.replace('proc rw', 'proc rw,hidepid=2');
 if (mode === 'mount-ancestry-overlay') mounts += ancestry + '6 4 0:2 / /proc/sys/kernel/random/boot_id ro - tmpfs tmpfs rw\n';
 if (mode === 'mount-random-other-device') mounts += ancestry.replace('4 3 0:1', '4 3 0:2');
 if (mode === 'mount-boot-wrong-root') mounts += ancestry.replace('/sys/kernel/random/boot_id /proc', '/sys/kernel/random/uuid /proc');
 if (mode === 'hidepid') mounts = mounts.replace('rw,nosuid', 'rw,hidepid=2,nosuid');
 if (mode === 'hidepid-super') mounts = mounts.replace('proc proc rw', 'proc proc rw,hidepid=1');
 if (mode === 'mount-subroot') mounts = mounts.replace('/ /proc', '/subset /proc');
 if (mode === 'mount-not-proc') mounts = mounts.replace('- proc', '- tmpfs');
 if (mode.startsWith('overlay-')) {
  const target = { self: 'self/ns', pid: '424242/ns', sys: 'sys/kernel', 'thread-self': 'thread-self', mounts: 'mounts', escaped: 'self\\057ns' }[mode.slice(8)]!;
  mounts += `2 1 0:2 / /proc/${target} rw - tmpfs tmpfs rw\n`;
 }
 return { release, listing, mounts, pid: mode === 'android' ? 'unsupported-no-pid' : 'pid:[123]',
  time: mode === 'android' || mode === 'old-absent' ? 'unsupported-pre5.6' : 'time:[123]',
  accepted: (pidfd && ['hidepid', 'hidepid-super', 'mount-sys-hidepid'].includes(mode)) || ['modern', 'old-present', 'old-absent', 'android', 'mount-question', 'mount-binfmt', 'mount-sys', 'mount-ancestry', 'mount-ancestry-reversed'].includes(mode) };
}
