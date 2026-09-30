-- This timer lives in the native player, not the shell/transport guardian.
local mp = require 'mp'
local scope = os.getenv('PI_VOICE_SCOPE')
local boot = os.getenv('PI_VOICE_BOOT')
local binding = os.getenv('PI_VOICE_BINDING')
local fifo = os.getenv('PI_VOICE_FIFO')
local deadline
local started = false
local expired = false
local function quit(code)
    expired = true
    assert(mp.commandv('quit', tostring(code or 1)))
end
local function guarded(callback)
    return function(...)
        local ok, err = pcall(callback, ...)
        if not ok then
            expired = true
            -- Neither a failed callback nor a failed quit may silently kill the watchdog.
            pcall(function() io.stderr:write('Pi Voice watchdog: ' .. tostring(err) .. '\n') end)
            pcall(mp.commandv, 'stop')
            pcall(mp.commandv, 'quit', '1')
        end
    end
end
local function alive()
    if expired or mp.get_time() >= deadline then quit(); return false end
    return true
end
local function read(file)
    local f = assert(io.open(file, 'r'))
    local value = assert(f:read('*a'))
    assert(f:close())
    return value
end
local function publish(file, value)
    local f = assert(io.open(file .. '.tmp', 'w'))
    assert(f:write(value)); assert(f:close())
    assert(os.rename(file .. '.tmp', file))
end
guarded(function()
    local utils = require 'mp.utils'
    local function namespace(pid, name)
        local result = utils.subprocess({args={'readlink', '/proc/' .. pid .. '/ns/' .. name}, cancellable=false})
        assert(result.status == 0)
        return assert(result.stdout:match('^' .. name .. ':%[%d+%]'))
    end
    assert(type(mp.commandv) == 'function')
    deadline = mp.get_time() + 30
    assert(mp.add_periodic_timer(0.1, guarded(alive)))
    local ack = binding .. '.ack'
    -- Exercise the exact ACK I/O path before advertising native capability.
    publish(ack, scope)
    assert(read(ack) == scope)
    assert(os.remove(ack))
    mp.register_script_message('pi-voice-renew', guarded(function(id, expected_boot, nonce)
        if id ~= scope or expected_boot ~= boot or not nonce or #nonce ~= 32 or not nonce:match('^[0-9a-f]+$') or not alive() then return end
        deadline = mp.get_time() + 30
        publish(ack, nonce)
    end))
    mp.register_script_message('pi-voice-start', guarded(function(id, expected_boot)
        if started or id ~= scope or expected_boot ~= boot or not alive() then return end
        started = true
        assert(mp.commandv('loadfile', fifo))
    end))
    mp.register_event('end-file', guarded(function(event)
        if not started then return end
        if not expired and event.reason == 'eof' and not event.error then
            publish(binding .. '.complete', scope)
            quit(0)
        else
            quit()
        end
    end))
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
    publish(binding, identity .. '\n')
end)()
