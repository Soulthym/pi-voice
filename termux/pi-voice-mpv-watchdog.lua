-- This timer lives in the native player, not the shell/transport guardian.
local mp = require 'mp'
local scope = os.getenv('PI_VOICE_SCOPE')
local boot = os.getenv('PI_VOICE_BOOT')
local binding = os.getenv('PI_VOICE_BINDING')
local fifo = os.getenv('PI_VOICE_FIFO')
local deadline
local started = false
local expired = false
local phase = 'setup'
local cause = 'syscall-failed'
local function quit(code)
    expired = true
    assert(mp.commandv('quit', tostring(code or 1)))
end
local function guarded(callback)
    return function(...)
        if expired then pcall(mp.commandv, 'quit', '1'); return end
        cause = 'syscall-failed'
        local ok = pcall(callback, ...)
        if not ok then
            expired = true
            -- Neither a failed callback nor a failed quit may silently kill the watchdog.
            -- Fixed phase codes only: never persist paths, subprocess output or PCM.
            -- The helper launches us with umask 077 in its private scope directory.
            pcall(function()
                local f = assert(io.open(binding .. '.error.tmp', 'w'))
                assert(f:write(phase .. ' ' .. cause .. '\n')); assert(f:close())
                assert(os.rename(binding .. '.error.tmp', binding .. '.error'))
            end)
            pcall(function() io.stderr:write('Pi Voice watchdog: ' .. phase .. ' ' .. cause .. '\n') end)
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
    phase = 'utils'
    cause = 'unavailable'
    local utils = require 'mp.utils'
    assert(type(utils.subprocess) == 'function')
    cause = 'syscall-failed'
    local function namespace(pid, name)
        phase = 'namespace-' .. name
        cause = 'subprocess-failed'
        local result = utils.subprocess({args={'readlink', '/proc/' .. pid .. '/ns/' .. name}, cancellable=false})
        cause = 'namespace-read-failed'
        assert(result.status == 0)
        cause = 'namespace-malformed'
        local value = assert(result.stdout:match('^(' .. name .. ':%[%d+%])\n?$'))
        cause = 'syscall-failed'
        return value
    end
    cause = 'unsupported'
    assert(type(mp.commandv) == 'function' and type(mp.get_time) == 'function' and
        type(mp.add_periodic_timer) == 'function' and type(mp.register_script_message) == 'function' and
        type(mp.register_event) == 'function')
    cause = 'syscall-failed'
    phase = 'timer'
    deadline = mp.get_time() + 30
    assert(mp.add_periodic_timer(0.1, guarded(function()
        phase = 'timer'
        return alive()
    end)))
    local ack = binding .. '.ack'
    -- Exercise the exact ACK I/O path before advertising native capability.
    phase = 'ack-probe'
    publish(ack, scope)
    assert(read(ack) == scope)
    assert(os.remove(ack))
    phase = 'callbacks'
    mp.register_script_message('pi-voice-renew', guarded(function(id, expected_boot, nonce)
        phase = 'renew'
        if id ~= scope or expected_boot ~= boot or not nonce or #nonce ~= 32 or not nonce:match('^[0-9a-f]+$') or not alive() then return end
        deadline = mp.get_time() + 30
        publish(ack, nonce)
    end))
    mp.register_script_message('pi-voice-start', guarded(function(id, expected_boot)
        phase = 'start'
        if started or id ~= scope or expected_boot ~= boot or not alive() then return end
        started = true
        assert(mp.commandv('loadfile', fifo))
    end))
    mp.register_event('end-file', guarded(function(event)
        phase = 'end-file'
        if not started then return end
        assert(event.reason ~= 'error' and not event.error)
        if not expired and event.reason == 'eof' then
            publish(binding .. '.complete', scope)
            quit(0)
        else
            quit()
        end
    end))
    phase = 'identity'
    local stat = read('/proc/self/stat')
    local pid, tail = stat:match('^(%d+) %(.+%) (.+)$')
    assert(pid and tail)
    -- Read the native reader's namespace, not the subprocess's or time_for_children.
    phase = 'kernel-release'
    local major, minor = read('/proc/sys/kernel/osrelease'):match('^(%d+)%.(%d+)%.')
    assert(major and minor)
    local timens
    if tonumber(major) < 5 or (tonumber(major) == 5 and tonumber(minor) < 6) then
        phase = 'namespace-list'
        cause = 'subprocess-failed'
        local result = utils.subprocess({args={'ls', '-1', '--', '/proc/' .. pid .. '/ns'}, cancellable=false})
        cause = 'namespace-read-failed'
        assert(result.status == 0)
        cause = 'namespace-malformed'
        local names = '\n' .. result.stdout .. '\n'
        assert(names:match('\npid\n') and names:match('\nmnt\n'))
        if not names:match('\ntime\n') then timens = 'unsupported-pre5.6' end
        cause = 'syscall-failed'
    end
    timens = timens or namespace(pid, 'time')
    phase = 'identity'
    local fields = {}
    for value in tail:gmatch('%S+') do fields[#fields+1] = value end
    local ticks = assert(fields[20])
    assert(ticks:match('^%d+$'))
    local uid = assert(read('/proc/self/status'):match('\nUid:%s+(%d+)%s'))
    assert(read('/proc/sys/kernel/random/boot_id'):match('^(%S+)') == boot)
    local identity = table.concat({scope, boot, pid, ticks, uid, namespace(pid, 'pid'), namespace(pid, 'mnt'), 'binding-v2', timens}, ' ')
    phase = 'binding-publish'
    publish(binding, identity .. '\n')
end)()
