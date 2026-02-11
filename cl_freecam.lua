print('[VLKN-CCAM] Client script starting...')
-- local Config = lib.load('config') -- Switched to global load

RegisterNUICallback('uploadToVPSProxy', function(data, cb)
    local image = data.image
    if not image then return cb(json.encode({ status = 'error', message = 'No image data' })) end

    local requestId = GetGameTimer() .. math.random(1000,9999)
    local chunkSize = 20 * 1024 -- 20KB chunks
    local totalLen = string.len(image)
    local numChunks = math.ceil(totalLen / chunkSize)

    print('[VLKN-CCAM] Starting Chunked Upload. Total: ' .. totalLen .. ' bytes. Chunks: ' .. numChunks)

    -- Use TriggerLatentServerEvent to prevent overflow
    -- 50000 bps = ~50KB/s. Safe for most connections.
    for i = 1, numChunks do
        local startIdx = (i - 1) * chunkSize + 1
        local endIdx = math.min(i * chunkSize, totalLen)
        local chunk = string.sub(image, startIdx, endIdx)
        
        TriggerLatentServerEvent('vlkn-ccam:uploadChunk', 50000, requestId, i, chunk)
        
        if i % 10 == 0 then Wait(50) end -- Extra safety yield
    end

    -- Send the rest of the data (minus the huge image string)
    local metaData = {
        workerUrl = data.workerUrl,
        webhookPayload = data.webhookPayload,
        watermark = data.watermark,
        notifyLog = data.notifyLog,
        totalChunks = numChunks
    }

    TriggerServerEvent('vlkn-ccam:uploadFinish', requestId, metaData)
    cb(json.encode({ status = 'ok' }))
end)

RegisterNetEvent('vlkn-ccam:clientLog', function(msg)
    print(msg) 
end)

-- Wait for Resource Start
CreateThread(function()
    Citizen.Wait(1000) -- Give some time for Config to be loaded globally if it's from another script
    if not Config then
        print('^1[VLKN-CCAM] CRITICAL ERROR: Config is nil! Check config.lua loading.^0')
        return
    else
        print('[VLKN-CCAM] Config loaded successfully. Command: ' .. tostring(Config.CommandName))
    end

    -- Force Chat Suggestion - Moved here to ensure Config is loaded
    Citizen.CreateThread(function()
        TriggerEvent('chat:addSuggestion', '/' .. Config.CommandName, 'Open Cinematic Camera Menu')
    end)
end)


local FREE_CAM
local offsetRotX, offsetRotY, offsetRotZ = 0.0, 0.0, 0.0
local offsetCoords = {x = 0.0, y = 0.0, z = 0.0}
local precision = 1.0
local speed = 0.2
local currFilter = 1
local camActive = false
local dofOn = false
local dofStrength = 0.5
local dofFar = 150.0
local dofNear = 0.10
local barsOn = false

local isSettingsOpen = false
local settingsIndex = 0
local pressTime = 0

-- Key Tracking
local keyStates = {}
local monitoredKeys = {
    { code = 32, label = 'W' },
    { code = 33, label = 'S' },
    { code = 34, label = 'A' },
    { code = 35, label = 'D' },
    { code = 44, label = 'Q' },
    { code = 38, label = 'E' },
    { code = 22, label = 'SPACE' },
    { code = 22, label = 'SPACE' },
    -- { code = 21, label = 'SHIFT' }, -- Removed
    { code = 174, label = 'LEFT' },
    { code = 175, label = 'RIGHT' },
    { code = 172, label = 'UP' },
    { code = 173, label = 'DOWN' },
    { code = 20, label = 'Z' },
    { code = 26, label = 'C' },
    { code = 45, label = 'R' }, -- Reset
    -- { code = 75, label = 'V' }, -- Removed for I KeyMapping
    { code = 177, label = 'BACKSPACE' },
    { code = 10, label = 'PAGEUP' },
    { code = 11, label = 'PAGEDOWN' },
    -- { code = 288, label = 'F1' }, -- Removed

}

local hideMap = false
-- ... (rest of file) ...


local function toggleMap()
    hideMap = not hideMap
    -- UI Update happens in updateSettings
    if not hideMap then DisplayRadar(true) end -- Restore if toggled back ON
end

local function toggleBars()
    barsOn = not barsOn
    -- Removed blocking loop; drawing handled in main thread
end

local function resetEverything()
    camActive = false -- Force stop any loops
    isSettingsOpen = false
    
    ClearFocus()
    SetNuiFocus(false, false) -- Ensure mouse/focus is cleared
    
    SetCamUseShallowDofMode(FREE_CAM, false)
    RenderScriptCams(false, false, 0, true, false)
    DestroyCam(FREE_CAM, false)
    offsetRotX = 0.0
    offsetRotY = 0.0
    offsetRotZ = 0.0
    speed = 0.2
    precision = 1.0
    currFov = GetGameplayCamFov()
    currFilter = 1
    ClearTimecycleModifier()
    FREE_CAM = nil
    dofStrength = 0.5
    dofFar = 150.0
    dofNear = 0.10
    dofOn = false
    barsOn = false
    DisplayRadar(true) -- Ensure map returns

    -- Force Hide UI purely for safety
    SendNUIMessage({type = 'ui', display = false})
    SendNUIMessage({type = 'settings', show = false})
end

local function setNewFov(setNewFov)
    if DoesCamExist(FREE_CAM) then
        local currFov = GetCamFov(FREE_CAM)
        local newFov = currFov + setNewFov

        if ((newFov >= Config.MinFov) and (newFov <= Config.MaxFov)) then
            SetCamFov(FREE_CAM, newFov)
        end
    end
end

local function toggleDof()
    dofOn = not dofOn
    if dofOn then
        if DoesCamExist(FREE_CAM) then
            SetCamUseShallowDofMode(FREE_CAM, true)
            SetCamNearDof(FREE_CAM, dofNear)
            SetCamFarDof(FREE_CAM, dofFar)
            SetCamDofStrength(FREE_CAM, dofStrength)
        end
    else
        dofStrength = 0.5
        dofFar = 150.0
        dofNear = 0.10
        SetCamNearDof(FREE_CAM, dofNear)
        SetCamFarDof(FREE_CAM, dofFar)
        SetCamDofStrength(FREE_CAM, dofStrength)
        SetCamUseShallowDofMode(FREE_CAM, false)
        ClearFocus()
    end
end

local function processNewPos(x, y, z)
    local newPos = {x = x, y = y, z = z}
    local moveSpeed = 0.1 * speed

    local function updatePosition(multX, multY, multZ, direction)
        newPos.x = newPos.x + direction * moveSpeed * multX
        newPos.y = newPos.y - direction * moveSpeed * multY
    end
    
    -- Update Key States for NUI
    for _, kData in ipairs(monitoredKeys) do
        local pressed = IsDisabledControlPressed(1, kData.code)
        if pressed ~= keyStates[kData.label] then
            keyStates[kData.label] = pressed
            SendNUIMessage({
                type = 'keypress',
                key = kData.label,
                active = pressed
            })
        end
    end
    
    local filterLabel = currFilter .. ' / ' .. #Config.Filters
    
    if IsDisabledControlPressed(1, 32) then -- W (forwards)
        updatePosition(Sin(offsetRotZ), Cos(offsetRotZ), Sin(offsetRotX), -1)
    elseif IsDisabledControlPressed(1, 33) then -- S (backwards)
        updatePosition(Sin(offsetRotZ), Cos(offsetRotZ), Sin(offsetRotX), 1)
    end

    if IsDisabledControlPressed(1, 34) then -- A (left)
        updatePosition(Sin(offsetRotZ + 90.0), Cos(offsetRotZ + 90.0), Sin(offsetRotY), -1)
    elseif IsDisabledControlPressed(1, 35) then -- D (right)
        updatePosition(Sin(offsetRotZ + 90.0), Cos(offsetRotZ + 90.0), Sin(offsetRotY), 1)
    end

    if IsDisabledControlPressed(1, 44) then -- Q (Up)
        newPos.z += moveSpeed
    elseif IsDisabledControlPressed(1, 38) then -- E (Down)
        newPos.z -= moveSpeed
    end

    -- Underground Check
    if Config.PreventUnderground then
        local foundGround, zPos = GetGroundZFor_3dCoord(newPos.x, newPos.y, newPos.z + 10.0, false)
        if foundGround and newPos.z < (zPos + 0.5) then
            -- Check if we are actually way below (interior/tunnels might fail this if we check strictly)
            -- But user asked to block it. 
            newPos.z = zPos + 0.5
        end
    end

    -- REMOVED SHIFT SPEED MODIFIER LOGIC

    -- Helper functions for Settings
    local function updateSettings()
         SendNUIMessage({
            type = 'settings',
            show = true,
            index = settingsIndex,
            data = {
                filter = currFilter .. ' / ' .. #Config.Filters,
                -- dof removed
                bars = barsOn,
                minimap = not hideMap
            }
        })
    end

    local function changeSetting(dir) 
         if settingsIndex == 0 then -- Filter
            if dir == -1 then
                currFilter = currFilter - 1
                if currFilter < 1 then currFilter = #Config.Filters end
            else
                currFilter = currFilter + 1
                if currFilter > #Config.Filters then currFilter = 1 end
            end
            SetTimecycleModifier(Config.Filters[currFilter])
        -- Index 1: Bars (Was DOF)
        elseif settingsIndex == 1 then 
            toggleBars()
        -- Index 2: Minimap
        elseif settingsIndex == 2 then 
            toggleMap()
        end
        updateSettings()
    end

    
    -- I Key Handling now done via Command/KeyMapping outside this loop, 
    -- but we check the state `isSettingsOpen` updated by that command.

    if isSettingsOpen then
        -- Menu Navigation Controls
        if IsDisabledControlJustPressed(1, 172) then -- Arrow Up
            settingsIndex = settingsIndex - 1
            if settingsIndex < 0 then settingsIndex = 2 end
            updateSettings()
        elseif IsDisabledControlJustPressed(1, 173) then -- Arrow Down
            settingsIndex = settingsIndex + 1
            if settingsIndex > 2 then settingsIndex = 0 end
            updateSettings()
        end

        -- Value Change Controls (Left/Right)
        local isLeftPressed = IsDisabledControlPressed(1, 174)
        local isRightPressed = IsDisabledControlPressed(1, 175)
        local isLeftJustPressed = IsDisabledControlJustPressed(1, 174)
        local isRightJustPressed = IsDisabledControlJustPressed(1, 175)
        
        if settingsIndex == 0 then -- FILTER: Tap for +1, Hold for Fast Scroll
            if isLeftJustPressed then
                changeSetting(-1)
                pressTime = GetGameTimer() -- Track when hold started
            elseif isRightJustPressed then
                changeSetting(1)
                pressTime = GetGameTimer()
            elseif isLeftPressed or isRightPressed then
                -- Fast Scroll after holding for 300ms
                if (GetGameTimer() - (pressTime or 0)) > 300 then 
                    changeSetting(isLeftPressed and -1 or 1)
                    Wait(50) -- Fast scroll speed
                end
            end
        else -- OTHER SETTINGS: Strict Tap Only (No fast scroll)
            if isLeftJustPressed then
                changeSetting(-1)
            elseif isRightJustPressed then
                changeSetting(1)
            end
        end
    end
    -- SCROLL HANDLING (Zoom In/Out) - User Requested
    if isSettingsOpen then
        -- SCROLL in Menu changes Value
        if IsDisabledControlPressed(1, 15) then -- Scroll Up
            changeSetting(1)
            Wait(100) -- throttle scroll
        elseif IsDisabledControlPressed(1, 14) then -- Scroll Down
            changeSetting(-1)
            Wait(100)
        end
    else
        -- Standard Zoom Logic (Menu Closed)
        if IsDisabledControlPressed(1, 15) then -- Mouse wheel up (Zoom In)
            setNewFov(-1.0)
            SendNUIMessage({type = 'scroll', key = 'SCROLLUP'})
        elseif IsDisabledControlPressed(1, 14) then -- Mouse wheel down (Zoom Out)
            setNewFov(1.0)
            SendNUIMessage({type = 'scroll', key = 'SCROLLDOWN'})
        end
    end

    
    -- BACKSPACE / ESC (Close Cam)
    -- explicitly ignore RMB (25) to prevent accidental closes
    local isRMB = IsDisabledControlPressed(1, 25)
    if (IsDisabledControlJustPressed(1, 177) and not isRMB) or IsDisabledControlJustPressed(1, 200) then 
        camActive = false
        isSettingsOpen = false
        SendNUIMessage({type = 'settings', show = false})
    end
    
    -- PageUp / PageDown (Roll Logic - User Requested)
    if not isSettingsOpen then
        if IsDisabledControlPressed(1, 10) then -- Page Up (Roll Left)
             offsetRotY = offsetRotY + moveSpeed * 5.0
             SendNUIMessage({type = 'keypress', key = 'PAGEUP', active = true})
        elseif IsDisabledControlPressed(1, 11) then -- Page Down (Roll Right)
             offsetRotY = offsetRotY - moveSpeed * 5.0
             SendNUIMessage({type = 'keypress', key = 'PAGEDOWN', active = true})
        end
    end
    
    -- Z / C (Zoom In/Out) - Matching UI
    if IsDisabledControlPressed(1, 20) then -- Z (Zoom In)
        setNewFov(-1.0)
        SendNUIMessage({type = 'keypress', key = 'Z', active = true})
    elseif IsDisabledControlPressed(1, 26) then -- C (Zoom Out)
        setNewFov(1.0)
        SendNUIMessage({type = 'keypress', key = 'C', active = true})
    end
    
    -- R (Reset Zoom & Roll) - User Requested
    if IsDisabledControlJustPressed(1, 45) then -- R
        offsetRotY = 0.0
        local defaultFov = GetGameplayCamFov()
        SetCamFov(FREE_CAM, defaultFov)
        SendNUIMessage({type = 'keypress', key = 'R', active = true})
    end

    -- Update Key States for Z/C visual feedback is handled in the main loop above, 
    -- but manual trigger here helps feel responsive if main loop misses.
    -- Actually the main monitoredKeys loop handles visual 'active' class toggling.

    if not isSettingsOpen then
        offsetRotX = offsetRotX - (GetDisabledControlNormal(1, 2) * precision * 8.0)
        offsetRotZ = offsetRotZ - (GetDisabledControlNormal(1, 1) * precision * 8.0)
    end
    
    -- Arrow Keys for Rotation (Only when settings closed)
    if not isSettingsOpen then
        if IsDisabledControlPressed(1, 174) then -- Arrow Left
            offsetRotZ = offsetRotZ + moveSpeed * 5.0
        elseif IsDisabledControlPressed(1, 175) then -- Arrow Right
            offsetRotZ = offsetRotZ - moveSpeed * 5.0
        end
    end
    
    -- Arrow Keys for Sensitivity (Speed) (Only when settings closed)
    if not isSettingsOpen then
         if IsDisabledControlPressed(1, 172) then -- Arrow Up (+Sensitivity)
            speed = math.min(speed + 0.1, Config.MaxSpeed)
        elseif IsDisabledControlPressed(1, 173) then -- Arrow Down (-Sensitivity)
            speed = math.max(speed - 0.1, Config.MinSpeed)
        end
    end


    offsetRotX = math.clamp(offsetRotX, -90.0, 90.0)
    offsetRotX = math.clamp(offsetRotX, -90.0, 90.0)
    -- offsetRotY is now controlled by PageUp/Down
    offsetRotZ = offsetRotZ % 360.0
    offsetRotZ = offsetRotZ % 360.0

    return newPos
end

local function processCamControls()
    DisableFirstPersonCamThisFrame()

    local camCoords = GetCamCoord(FREE_CAM)
    local newPos = processNewPos(camCoords.x, camCoords.y, camCoords.z)
    SetFocusArea(newPos.x, newPos.y, newPos.z, 0.0, 0.0, 0.0)
    SetCamCoord(FREE_CAM, newPos.x, newPos.y, newPos.z)
    SetCamRot(FREE_CAM, offsetRotX, offsetRotY, offsetRotZ, 2)

    for k, v in pairs(Config.DisabledControls) do
        DisableControlAction(0, v, true)
    end

    local currentPos = GetEntityCoords(cache.ped)
    if #(currentPos - vec3(newPos.x, newPos.y, newPos.z)) > Config.MaxDistance then
    if not IsEntityDead(cache.ped) then
            TriggerEvent('ox_lib:notify', { type = 'error', description = 'You went too far using the free camera.' })
        end
        camActive = false
        TriggerEvent('ox_lib:hideMenu') -- Safe alternative or just rely on resetEverything
    end

    -- Send NUI Update
    SendNUIMessage({
        type = 'update',
        zoom = GetCamFov(FREE_CAM)
    })

    -- CAPTURE LOGIC (SPACE)
    -- Moved to Thread to prevent blocking control loop
    if IsDisabledControlJustPressed(1, 22) then -- Space
        print('[VLKN-CCAM] Space Key Pressed - Starting Capture') -- DEBUG
        CreateThread(function()
            -- HIDE CONTROLS ONLY (Keep Watermark - though for canvas method we might not need NUI visible, we keep it for preview)
            SendNUIMessage({type = 'screenshotMode', enabled = true}) 
            Wait(1000) -- Wait for UI to hide

            if not Config.Webhook or Config.Webhook == '' or Config.Webhook:find('YOUR DISCORD WEBHOOK') then
                print('[VLKN-CCAM] Error: Discord Webhook not configured in config.lua!')
                TriggerEvent('ox_lib:notify', {type = 'error', description = 'Error: Webhook not configured!'})
                if camActive then SendNUIMessage({type = 'screenshotMode', enabled = false}) end
                return
            end

            print('[VLKN-CCAM] Requesting Screenshot...') -- DEBUG

            -- REQUEST BASE64 (Client Composition)
            -- Quality controlled by Config.CaptureQuality
            exports['screenshot-basic']:requestScreenshot({                encoding = 'jpg', -- Vercel Limit Optimization
                quality = Config.CaptureQuality or 0.9
            }, function(data)
                print('[VLKN-CCAM] Screenshot Data Received. Length: ' .. tostring(#data)) -- DEBUG
                -- Send Data to NUI for Canvas Composition & Upload
                SendNUIMessage({
                    type = 'perform_capture',
                    base64 = data,
                    webhook = Config.Webhook,
                    workerUrl = Config.UploadServiceUrl, -- Pass Worker URL
                    watermark = Config.Watermark,
                    embed = Config.Embed, -- Pass Embed config
                    notifyLog = Config.EnableWebhookLog
                })
                
                -- Restore Controls immediately after grabbing frame
                Wait(100) 
                if camActive then 
                    SendNUIMessage({type = 'screenshotMode', enabled = false}) 
                end
            end)
        end)
    end
    
    if barsOn then
        DrawRect(0.5, 0.05, 1.0, 0.1, 0, 0, 0, 255) -- Top Bar
        DrawRect(0.5, 0.95, 1.0, 0.1, 0, 0, 0, 255) -- Bottom Bar
    end
    
    -- Force Map Hide Loop
    if hideMap then
        DisplayRadar(false)
    end
end

local function toggleCam()
    camActive = not camActive
    if camActive then
        ClearFocus()
        FREE_CAM = CreateCamWithParams('DEFAULT_SCRIPTED_CAMERA', GetEntityCoords(cache.ped), 0, 0, 0, GetGameplayCamFov() * 1.0)
        SetCamActive(FREE_CAM, true)
        RenderScriptCams(true, false, 0, true, false)
        SetCamAffectsAiming(FREE_CAM, false)
        
        -- Send Watermark Config
        SendNUIMessage({
            type = 'watermark',
            show = false,
            src = Config.Watermark.Logo,
            opacity = Config.Watermark.Opacity,
            position = Config.Watermark.Position,
            size = Config.Watermark.LogoSize -- Single size value
        })
        
        SendNUIMessage({type = 'ui', display = true}) -- Show UI
        
        -- Default Map State
        hideMap = true 
        barsOn = true 

        CreateThread(function()
            while camActive do
                processCamControls()
                Wait(0)
            end
            resetEverything()
            -- Ensure UI is hidden and Watermark is reset
            SendNUIMessage({type = 'ui', display = false})
            SendNUIMessage({type = 'screenshotMode', enabled = false})
            SendNUIMessage({type = 'watermark', show = false}) -- Force Hide
        end)
    else
        SendNUIMessage({type = 'ui', display = false})
        SetNuiFocus(false, false) -- Ensure mouse is gone
    end
end

RegisterNetEvent('vlkn-ccam:client:open', function()
    if not camActive then
        toggleCam()
    end
end)

RegisterNUICallback('closeMenu', function(data, cb)
    isSettingsOpen = false
    SetNuiFocus(false, false)
    SendNUIMessage({type = 'settings', show = false})
    cb('ok')
end)

-- NUI Callback: Upload Success/Fail (Vercel)
RegisterNUICallback('notify_capture', function(data, cb)
    if data.success then
        lib.notify({
            title = 'Screenshot Uploaded!',
            description = 'Check your Discord',
            type = 'success',
            duration = 5000
        })
        
        -- Trigger Server to send DM if URL exists
        if data.url then
             TriggerServerEvent('vlkn-ccam:sendDM', data.url)
        end
    else
        lib.notify({
            title = 'Upload Failed',
            description = data.message,
            type = 'error'
        })
    end
    cb('ok')
end)

RegisterNUICallback('setKeyboardFocus', function(data, cb)
    SetNuiFocus(data.focus, true) -- Toggle Keyboard focus, keep Cursor
    cb('ok')
end)

RegisterNUICallback('setFilter', function(data, cb)
    if data.index and data.index > 0 then
        currFilter = math.clamp(data.index, 1, #Config.Filters)
        SetTimecycleModifier(Config.Filters[currFilter])
    end
    -- Trigger UI update to reflect the change (or reset if invalid)
    SendNUIMessage({
        type = 'settings',
        show = true,
        index = settingsIndex,
        data = {
            filter = currFilter .. ' / ' .. #Config.Filters,
            dof = dofOn,
            bars = barsOn,
            minimap = not hideMap
        }
    })
    cb('ok')
end)

 
RegisterCommand(Config.CommandName, function()
    print('Command /' .. Config.CommandName .. ' triggered!')
    toggleCam()
end)

RegisterNUICallback('notify_capture', function(data, cb)
    if data.success then
        TriggerEvent('ox_lib:notify', {type = 'success', description = data.message})
        
        -- Trigger DM Logic if URL is present
        if data.url then
            TriggerServerEvent('vlkn-freecam:server:capture', data.url)
        end
    else
        TriggerEvent('ox_lib:notify', {type = 'error', description = data.message or 'Upload Failed'})
    end
    cb('ok')
end)

RegisterCommand('vlkn_settings', function()
    if camActive then
        isSettingsOpen = not isSettingsOpen
        -- keepInput = true (false arg 1), hasCursor = isSettingsOpen
        SetNuiFocus(false, isSettingsOpen) 
        SendNUIMessage({
            type = 'settings',
            show = isSettingsOpen,
            index = settingsIndex,
            data = {
                filter = currFilter .. ' / ' .. #Config.Filters,
                bars = barsOn,
                minimap = not hideMap
            }
        })
    end
end, false)


RegisterKeyMapping('vlkn_settings', 'Toggle Freecam Settings', 'keyboard', 'o')

AddEventHandler('gameEventTriggered', function(event, data)
    if event ~= 'CEventNetworkEntityDamage' then return end
    local victim, victimDied = data[1], data[4]
    if not IsPedAPlayer(victim) then return end
    if victimDied and NetworkGetPlayerIndexFromPed(victim) == cache.playerId and (IsPedDeadOrDying(victim, true) or IsPedFatallyInjured(victim)) then
        if DoesCamExist(FREE_CAM) then
            resetEverything()
        end
    end
end)