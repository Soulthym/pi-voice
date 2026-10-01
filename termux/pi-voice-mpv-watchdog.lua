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
local function read(file, limit)
    limit = limit or 1048576
    local f = assert(io.open(file, 'r'))
    local value = assert(f:read(limit + 1))
    assert(f:close())
    assert(#value <= limit and not value:find('\0', 1, true))
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
        assert(type(result.stdout) == 'string' and #result.stdout <= 32)
        local value = assert(result.stdout:match('^(' .. name .. ':%[%d+%])\n?$'))
        assert(#assert(value:match('%[(%d+)%]')) <= 20)
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
    assert(pid and tail and #pid <= 10 and pid:match('^[1-9]%d*$'))
    -- Reject overlays before using directory enumeration as evidence of absence.
    phase = 'proc-mounts'
    local mounts = read('/proc/self/mountinfo')
    local visible, device, seen = false, nil, {}
    assert(mounts:sub(-1) == '\n' and not mounts:find('\n\n', 1, true))
    for line in mounts:gmatch('([^\n]+)\n') do
        local dev, root, mount, options = line:match('^%d+ %d+ (%d+:%d+) (%S+) (%S+) (%S+) ')
        local kind, super = line:match(' %- (%S+) %S+ (%S+)$')
        assert(root and kind)
        if mount == '/proc' or mount == '/proc/sys' or mount == '/proc/sys/kernel' or
            mount == '/proc/sys/kernel/random' or mount == '/proc/sys/kernel/random/boot_id' then
            -- Only the identical procfs subtree may cover the boot identity ancestry.
            assert(kind == 'proc' and not seen[mount] and (not device or device == dev))
            assert(root == (mount == '/proc' and '/' or mount:sub(6)))
            device, seen[mount] = dev, true
            if mount == '/proc' then visible = true end
            for option in (options .. ',' .. super):gmatch('[^,]+') do
                assert(not option:match('^hidepid=') or option == 'hidepid=0')
            end
        elseif mount:sub(1, 6) == '/proc/' then
            local first = mount:match('^/proc/([^/]+)')
            assert(first ~= 'self' and first ~= 'thread-self' and
                first ~= 'mounts' and not first:match('^%d+$') and not mount:find('\\', 1, true))
        end
    end
    assert(visible)
    -- uname works on Android where the procfs osrelease leaf may not exist.
    phase = 'kernel-release'
    cause = 'subprocess-failed'
    local result = utils.subprocess({args={'uname', '-r'}, cancellable=false})
    assert(result.status == 0)
    cause = 'namespace-malformed'
    assert(type(result.stdout) == 'string' and #result.stdout <= 65)
    local release = result.stdout:gsub('\n$', '')
    local major, minor, patch, suffix = release:match('^(%d+)%.(%d+)%.(%d+)(.*)$')
    assert(major and #major <= 3 and #minor <= 3 and #patch <= 6 and #release <= 64)
    assert(suffix == '' or suffix:match('^[-+._a-zA-Z][-+._a-zA-Z0-9]*$'))
    -- Read the native reader's namespace, not the subprocess's or time_for_children.
    phase = 'namespace-list'
    cause = 'subprocess-failed'
    result = utils.subprocess({args={'ls', '-1A', '--', '/proc/' .. pid .. '/ns'}, cancellable=false})
    cause = 'namespace-read-failed'
    assert(result.status == 0)
    cause = 'namespace-malformed'
    assert(type(result.stdout) == 'string' and #result.stdout <= 4096 and result.stdout:sub(-1) == '\n')
    local names = {}
    for name in result.stdout:gmatch('([^\n]*)\n') do
        assert(#name <= 64 and name:match('^[a-z][a-z0-9_]*$') and not names[name])
        names[name] = true
    end
    assert(names.mnt)
    local mntns = namespace(pid, 'mnt')
    local pidns = names.pid and namespace(pid, 'pid') or 'unsupported-no-pid'
    local timens
    if names.time then
        timens = namespace(pid, 'time')
    else
        phase = 'namespace-time'
        cause = 'namespace-malformed'
        assert(tonumber(major) < 5 or (tonumber(major) == 5 and tonumber(minor) < 6))
        timens = 'unsupported-pre5.6'
    end
    phase = 'identity'
    cause = 'syscall-failed'
    local fields = {}
    for value in tail:gmatch('%S+') do fields[#fields+1] = value end
    local ticks = assert(fields[20])
    assert(#ticks <= 20 and ticks:match('^%d+$'))
    local uid = assert(read('/proc/self/status'):match('\nUid:%s+(%d+)%s'))
    assert(#uid <= 10)
    local current_boot = read('/proc/sys/kernel/random/boot_id', 37)
    assert(current_boot == boot or current_boot == boot .. '\n')
    local identity = table.concat({scope, boot, pid, ticks, uid, pidns, mntns, 'binding-v3', timens}, ' ')
    phase = 'binding-publish'
    publish(binding, identity .. '\n')
end)()
