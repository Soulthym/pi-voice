-- Deterministic native API/I/O failures; no mpv process or audio device.
local script, mode = arg[1], arg[2]
local binding = os.getenv('PI_VOICE_BINDING')
local scope, boot = os.getenv('PI_VOICE_SCOPE'), os.getenv('PI_VOICE_BOOT')
local callbacks, commands = {}, {}
local armed = mode:match('^setup%-') ~= nil
local function fail(name)
    if armed and mode:gsub('^setup%-', '') == name then error('injected ' .. name) end
end
local mp = {
    get_time = function() fail('clock'); return 100 end,
    add_periodic_timer = function(_, cb) fail('timer'); callbacks.timer = cb; return {} end,
    register_script_message = function(name, cb) fail('message'); callbacks[name] = cb end,
    register_event = function(name, cb) fail('event'); callbacks[name] = cb end,
    commandv = function(name)
        commands[#commands+1] = name
        fail(name)
        if armed and mode == 'load-return' and name == 'loadfile' then return nil, 'failed' end
        return true
    end,
}
package.preload['mp'] = function() return mp end
package.preload['mp.utils'] = function()
    fail('utils')
    return {subprocess = function(args)
        if args.args[1] == 'uname' then return {status=0, stdout='6.8.0\n'} end
        if args.args[1] == 'ls' then return {status=0, stdout='pid\nmnt\ntime\n'} end
        local name = args.args[2]:match('/ns/(%w+)$')
        return {status=0, stdout=name .. ':[123]\n'}
    end}
end
local open, rename = io.open, os.rename
io.open = function(file, access)
    if file == binding .. '.ack.tmp' or file == binding .. '.complete.tmp' then
        fail('open')
        if armed and (mode:gsub('^setup%-', '') == 'write' or mode:gsub('^setup%-', '') == 'close') then
            return {
                write = function(self) fail('write'); return self end,
                close = function() fail('close'); return true end,
            }
        end
    end
    return open(file, access)
end
os.rename = function(...)
    fail('rename')
    return rename(...)
end
dofile(script)
if mode:match('^setup%-') then
    assert(open(binding) == nil, 'failed capability must not publish binding')
else
    local f = assert(open(binding)); f:close()
    assert(open(binding .. '.ack') == nil, 'capability probe must be ephemeral')
    if mode == 'end-file' then
        callbacks['pi-voice-start'](scope, boot)
        armed = true
        callbacks['end-file'](nil)
    elseif mode == 'complete' then
        callbacks['pi-voice-start'](scope, boot)
        mode = 'rename'; armed = true
        callbacks['end-file']({reason='eof'})
    elseif mode == 'loadfile' or mode == 'load-return' then
        armed = true
        callbacks['pi-voice-start'](scope, boot)
    elseif mode == 'quit' then
        -- An error event calls quit; throwing quit must still attempt stop.
        callbacks['pi-voice-start'](scope, boot)
        armed = true
        callbacks['end-file']({reason='error'})
    elseif mode == 'clock' then
        armed = true
        callbacks.timer()
    else
        armed = true
        callbacks['pi-voice-renew'](scope, boot, string.rep('a', 32))
    end
end
assert(commands[#commands-1] == 'stop' and commands[#commands] == 'quit', 'failure must attempt stop AND quit')
assert(open(binding .. '.ack') == nil, 'failed callback must not acknowledge renewal')
assert(open(binding .. '.complete') == nil, 'failure is not successful completion')
if callbacks.timer then
    armed = false
    callbacks.timer()
    assert(commands[#commands] == 'quit', 'watchdog remains expired and retries shutdown')
    local count = #commands
    callbacks['pi-voice-start'] = callbacks['pi-voice-start'] or function() end
    callbacks['pi-voice-start'](scope, boot)
    for i=count+1,#commands do assert(commands[i] ~= 'loadfile', 'failure must seal admission') end
end
