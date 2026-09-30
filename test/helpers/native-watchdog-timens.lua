-- Trusted-kernel/proc metadata injection; never invokes mpv or an audio device.
local script, mode = arg[1], arg[2]
local binding = os.getenv('PI_VOICE_BINDING')
local commands = {}
package.preload['mp'] = function() return {
    get_time=function() return 100 end,
    add_periodic_timer=function() return {} end,
    commandv=function(name) commands[#commands+1]=name; return true end,
    register_script_message=function() end,
    register_event=function() end,
} end
local open = io.open
io.open = function(file, access)
    if file == '/proc/sys/kernel/osrelease' then
        if mode == 'release-error' then return nil, 'Permission denied' end
        return {read=function() return mode:match('^old') and '5.4.0-fp5\n' or '6.8.0\n' end, close=function() return true end}
    end
    return open(file, access)
end
package.preload['mp.utils'] = function() return {subprocess=function(args)
    if args.args[1] == 'ls' then
        if mode == 'old-list-error' then return {status=1, stdout=''} end
        if mode == 'old-hidden' then return {status=0, stdout=''} end
        return {status=0, stdout=mode == 'old-absent' and 'pid\nmnt\n' or 'pid\nmnt\ntime\n'}
    end
    local name = args.args[2]:match('/ns/(%w+)$')
    if name == 'time' then
        assert(not args.args[2]:match('/self/'), 'must identify the native reader, not the subprocess')
        if mode == 'modern-absent' or mode == 'read-error' or mode == 'old-read-error' then
            return {status=1, stdout=''}
        end
        if mode == 'malformed' then return {status=0, stdout='time:[123] garbage\n'} end
    end
    return {status=0, stdout=name .. ':[123]\n'}
end} end
dofile(script)
if mode == 'modern' or mode == 'old-present' or mode == 'old-absent' then
    assert(#commands == 0)
    local f = assert(open(binding)); local value = f:read('*a'); f:close()
    local expected = mode == 'old-absent' and 'unsupported-pre5.6' or 'time:[123]'
    assert(value:sub(-#expected-12) == 'binding-v2 ' .. expected .. '\n', value)
else
    assert(open(binding) == nil, 'unknown domain must not publish a binding')
    assert(commands[#commands-1] == 'stop' and commands[#commands] == 'quit')
end
