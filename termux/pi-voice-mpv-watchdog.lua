-- This timer lives in the native player, not the shell/transport guardian.
local mp = require 'mp'
local utils = require 'mp.utils'
local scope = os.getenv('PI_VOICE_SCOPE')
local boot = os.getenv('PI_VOICE_BOOT')
local binding = os.getenv('PI_VOICE_BINDING')
local fifo = os.getenv('PI_VOICE_FIFO')
local deadline = mp.get_time() + 30
local started = false
local expired = false
local function quit(code)
    expired = true
    mp.commandv('quit', tostring(code or 1))
end
local function alive()
    if expired or mp.get_time() >= deadline then quit(); return false end
    return true
end
mp.add_periodic_timer(0.1, alive)
local function read(file)
    local f = assert(io.open(file, 'r'))
    local value = assert(f:read('*a'))
    assert(f:close())
    return value
end
local function namespace(pid, name)
    local result = utils.subprocess({args={'readlink', '/proc/' .. pid .. '/ns/' .. name}, cancellable=false})
    assert(result.status == 0)
    return assert(result.stdout:match('^' .. name .. ':%[%d+%]'))
end
local ok = pcall(function()
    local stat = read('/proc/self/stat')
    local pid, tail = stat:match('^(%d+) %(.+%) (.+)$')
    assert(pid and tail)
    local fields = {}
    for value in tail:gmatch('%S+') do fields[#fields+1] = value end
    local ticks = assert(fields[20])
    assert(ticks:match('^%d+$'))
    local uid = assert(read('/proc/self/status'):match('\nUid:%s+(%d+)%s'))
    assert(read('/proc/sys/kernel/random/boot_id'):match('^(%S+)') == boot)
    local identity = table.concat({scope, boot, pid, ticks, uid, namespace(pid, 'pid'), namespace(pid, 'mnt')}, ' ')
    local f = assert(io.open(binding .. '.tmp', 'w'))
    assert(f:write(identity .. '\n')); assert(f:close())
    assert(os.rename(binding .. '.tmp', binding))
end)
if not ok then quit(); return end
mp.register_script_message('pi-voice-renew', function(id, expected_boot, nonce)
    if id ~= scope or expected_boot ~= boot or not nonce or not nonce:match('^[0-9a-f]+$') or not alive() then return end
    deadline = mp.get_time() + 30
    mp.set_property('shared-script-properties/pi-voice-renewed', nonce)
end)
mp.register_script_message('pi-voice-start', function(id, expected_boot)
    if started or id ~= scope or expected_boot ~= boot or not alive() then return end
    started = true
    mp.commandv('loadfile', fifo)
end)
mp.register_event('end-file', function(event)
    if not started then return end
    if not expired and event.reason == 'eof' and not event.error then
        local f = io.open(binding .. '.complete', 'w')
        if f then f:write(scope); f:close() end
        quit(0)
    else
        quit()
    end
end)
