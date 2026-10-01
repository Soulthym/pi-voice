-- Synthetic Android/Linux proc capabilities; no hardware, mpv or audio device.
local script, mode = arg[1], arg[2]
local binding, root = os.getenv('PI_VOICE_BINDING'), os.getenv('HOME')
local commands, callbacks = {}, {}
package.preload['mp'] = function() return {
    get_time=function() return 100 end,
    add_periodic_timer=function() return {} end,
    commandv=function(name) commands[#commands+1]=name; return true end,
    register_script_message=function(name, cb) callbacks[name]=cb end,
    register_event=function() end,
} end
local open = io.open
local function contents(name)
    local f = assert(open(root .. '/' .. name)); local value = f:read('*a'); f:close(); return value
end
io.open = function(file, access)
    if file == '/proc/self/stat' and mode == 'procview-mismatch' then
        local f = assert(open(file)); local value = f:read('*a'); f:close()
        local fake = assert(open(root .. '/stat', 'w')); fake:write((value:gsub('^%d+', '2147483647'))); fake:close()
        return open(root .. '/stat', access)
    end
    if file == '/proc/sys/kernel/osrelease' then error('osrelease must not be read on Android') end
    if file == '/proc/self/mountinfo' then
        if mode == 'mount-error' then return nil, 'Permission denied' end
        return open(root .. '/mounts', access)
    end
    return open(file, access)
end
package.preload['mp.utils'] = function() return {getpid=mode ~= 'getpid-missing' and function()
    if mode == 'getpid-error' then error('getpid unavailable') end
    local f = assert(open('/proc/self/stat')); local pid = tonumber(f:read('*a'):match('^(%d+)')); f:close()
    return mode == 'getpid-mismatch' and pid + 1 or pid
end or nil, subprocess=function(args)
    if args.args[1] == 'uname' then
        assert(args.args[2] == '-r')
        return {status=mode == 'uname-error' and 1 or 0, stdout=contents('release')}
    end
    if args.args[1] == 'ls' then
        assert(args.args[2] == '-1A')
        assert(args.args[4]:match('^/proc/%d+/ns$'))
        return {status=(mode == 'list-error' or mode == 'old-list-error') and 1 or 0, stdout=contents('listing')}
    end
    local name = args.args[2]:match('^/proc/%d+/ns/(%w+)$')
    assert(name, 'must identify the native reader, not the subprocess')
    if mode == 'android' then assert(name == 'mnt', 'absent PID/time must not be read') end
    if mode == name .. '-denied' or mode == 'old-' .. name .. '-denied' then return {status=1, stdout=''} end
    if mode == 'link-malformed' then return {status=0, stdout=name .. ':[123] garbage\n'} end
    if mode == 'link-nul' then return {status=0, stdout=name .. ':[123]\0\n'} end
    if mode == 'link-long' then return {status=0, stdout=name .. ':[' .. string.rep('1', 21) .. ']\n'} end
    return {status=0, stdout=name .. ':[123]\n'}
end} end
dofile(script)
if os.getenv('ACCEPTED') == 'true' then
    assert(#commands == 0)
    local f = assert(open(binding)); local value = f:read('*a'); f:close()
    local expected = os.getenv('EXPECTED_NAMESPACES')
    assert(value:match(' (%S+ mnt:%[123%] binding%-v4 %S+)\n$') == expected, value)
    callbacks['pi-voice-start'](os.getenv('PI_VOICE_SCOPE'), os.getenv('PI_VOICE_BOOT'))
    assert(commands[1] == 'loadfile', 'validated capability admits PCM')
else
    assert(open(binding) == nil, 'unknown domain must not publish a binding')
    assert(commands[#commands-1] == 'stop' and commands[#commands] == 'quit')
    local f = assert(open(binding .. '.error')); local value = f:read('*a'); f:close()
    local phase, cause = 'namespace-list', 'namespace-malformed'
    if mode:match('^getpid%-') or mode == 'procview-mismatch' then
        phase, cause = 'pid-alignment', 'unsupported'
    elseif mode:match('^mount%-') or mode:match('^overlay%-') or mode:match('^hidepid') then
        phase, cause = 'proc-mounts', 'syscall-failed'
    elseif mode == 'uname-error' or mode:match('^release%-') then
        phase = 'kernel-release'
        cause = mode == 'uname-error' and 'subprocess-failed' or 'namespace-malformed'
    elseif mode:match('list%-error$') then
        cause = 'namespace-read-failed'
    elseif mode == 'modern-absent' then
        phase = 'namespace-time'
    elseif mode:match('%-denied$') then
        phase = 'namespace-' .. assert(mode:match('([a-z]+)%-denied$'))
        cause = 'namespace-read-failed'
    elseif mode:match('^link%-') then
        phase = 'namespace-mnt'
    end
    assert(value == phase .. ' ' .. cause .. '\n', value)
    local count = #commands
    if callbacks['pi-voice-start'] then callbacks['pi-voice-start'](os.getenv('PI_VOICE_SCOPE'), os.getenv('PI_VOICE_BOOT')) end
    for i=count+1,#commands do assert(commands[i] ~= 'loadfile') end
end
