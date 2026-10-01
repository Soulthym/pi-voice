// Synthetic foreground player identity; never substitutes for a real mpv test.
export const nativeBinding = `
const binding = process.env.PI_VOICE_BINDING;
const ticks = fs.readFileSync('/proc/self/stat', 'utf8').replace(/^.*\\) /, '').split(' ')[19];
fs.writeFileSync(binding, [process.env.PI_VOICE_SCOPE, process.env.PI_VOICE_BOOT,
 process.pid, ticks, process.getuid(), fs.readlinkSync('/proc/self/ns/pid'),
 fs.readlinkSync('/proc/self/ns/mnt'), 'binding-v3', fs.readlinkSync('/proc/self/ns/time')].join(' ') + '\\n');
`;
