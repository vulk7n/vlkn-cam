local function sendToDiscord(source, data)
    local webhook = Config.Webhook
    
    if not webhook or webhook == "" or webhook == "REPLACE_WITH_YOUR_DISCORD_WEBHOOK" then
        print("^1[VLKN-FREECAM] Error: Webhook not configured in config.lua^0")
        return
    end

    local plyName = GetPlayerName(source)
    local payload = json.encode({
        username = "Freecam Bot",
        embeds = {
            {
                title = "Screenshot Captured",
                color = 3447003,
                author = {
                    name = plyName
                },
                image = {
                    url = data 
                },
                footer = {
                    text = "VLKN Freecam • " .. os.date("%x %X %p")
                }
            }
        }
    })
    
    PerformHttpRequest(webhook, function(err, text, headers) end, 'POST', payload, { ['Content-Type'] = 'application/json' })
end

local function getDiscordId(source)
    for i = 0, GetNumPlayerIdentifiers(source) - 1 do
        local id = GetPlayerIdentifier(source, i)
        if id and id:find('discord:') then
            return id:gsub('discord:', '')
        end
    end
    return nil
end

-- Network Event to trigger DM from Client (Vercel Integration)
RegisterNetEvent('vlkn-ccam:sendDM', function(url)
    local source = source
    if url then
        sendToDiscordDM(source, url)
    end
end)

-- Command to open Freecam
RegisterCommand('ccam', function(source, args) end)

local function sendToDiscordDM(source, imageUrl)
    local botToken = Config.DiscordBotToken
    if not botToken or botToken == "" or botToken:find('YOUR DISCORD BOT TOKEN') then
        print("^1[VLKN-FREECAM] Error: Discord Bot Token not configured for DMs!^0")
        TriggerClientEvent('ox_lib:notify', source, {type = 'error', description = 'Bot token missing. Contact server admin.'})
        return
    end

    local discordId = getDiscordId(source)
    if not discordId then
        TriggerClientEvent('ox_lib:notify', source, {type = 'error', description = 'Discord ID not found. Ensure Discord is open.'})
        return
    end

    -- 1. Create DM Channel
    PerformHttpRequest('https://discord.com/api/v10/users/@me/channels', function(err, text, headers)
        if err ~= 200 then
            print("^1[VLKN-FREECAM] Error creating DM channel. Status: " .. tostring(err) .. " Body: " .. tostring(text) .. "^0")
            
            if err == 403 then
                TriggerClientEvent('ox_lib:notify', source, {type = 'error', description = 'Cannot DM you. Enable "Allow Direct Messages from Server Members".'})
            else
                TriggerClientEvent('ox_lib:notify', source, {type = 'error', description = 'Discord API Error: ' .. tostring(err)})
            end
            return
        end
        
        local data = json.decode(text)
        if not data or not data.id then 
            print("^1[VLKN-FREECAM] Error: Invalid response from Discord API (No Channel ID)^0")
            return 
        end
        local channelId = data.id

        -- Helper: Convert Hex string to Decimal
        local function hexToDecimal(hex)
            if type(hex) ~= 'string' then return hex end
            hex = hex:gsub('#', '')
            -- Trim to first 6 chars if longer (handle RGBA like 9500ffff)
            if #hex > 6 then hex = hex:sub(1, 6) end
            return tonumber(hex, 16) or 3447003 -- fallback blue
        end

        -- 2. Send Message
        local payload = json.encode({
            embeds = {
                {
                    title = Config.Embed.Title,
                    image = { url = imageUrl },
                    color = hexToDecimal(Config.Embed.Color),
                    footer = { 
                        text = Config.Embed.Footer .. " • " .. os.date("%x %X"),
                        icon_url = Config.Embed.FooterIcon 
                    }
                }
            }
        })

        PerformHttpRequest('https://discord.com/api/v10/channels/' .. channelId .. '/messages', function(err2, text2, headers2)
            if err2 ~= 200 then
                 print("^1[VLKN-FREECAM] Error sending DM. Status: " .. tostring(err2) .. " Body: " .. tostring(text2) .. "^0")
                 if err2 == 403 then
                    TriggerClientEvent('ox_lib:notify', source, {type = 'error', description = 'Could not send DM. Privacy settings may indicate "Allow Direct Messages from Server Members" is OFF.'})
                 else
                    TriggerClientEvent('ox_lib:notify', source, {type = 'error', description = 'Failed to send DM. Status: '..tostring(err2)})
                 end
            else
                 TriggerClientEvent('ox_lib:notify', source, {type = 'success', description = 'Check your DMs! Screenshot sent.'})
            end
        end, 'POST', payload, {
            ['Content-Type'] = 'application/json',
            ['Authorization'] = 'Bot ' .. botToken
        })

    end, 'POST', json.encode({ recipient_id = discordId }), {
        ['Content-Type'] = 'application/json',
        ['Authorization'] = 'Bot ' .. botToken
    })
end

RegisterNetEvent('vlkn-freecam:server:capture', function(url)
    local src = source
    if not url then return end
    print('[VLKN-CCAM] Screenshot URL received: ' .. url)
    
    if Config.SendToDM then
        sendToDiscordDM(src, url)
    else
        sendToDiscord(src, url)
    end
end)

local uploadBuffers = {}

RegisterNetEvent('vlkn-ccam:uploadChunk', function(requestId, index, chunk)
    local src = source
    if not uploadBuffers[src] then uploadBuffers[src] = {} end
    if not uploadBuffers[src][requestId] then uploadBuffers[src][requestId] = {} end
    
    uploadBuffers[src][requestId][index] = chunk
end)

RegisterNetEvent('vlkn-ccam:uploadFinish', function(requestId, data)
    local src = source
    local workerUrl = data.workerUrl

    if not uploadBuffers[src] or not uploadBuffers[src][requestId] then
        print("[VLKN-CCAM] Error: No chunks found for Request ID: " .. tostring(requestId))
        return
    end

    -- Reassemble Image
    local chunks = uploadBuffers[src][requestId]
    local imageParts = {}
    -- Ensure order
    for i = 1, data.totalChunks do
        if not chunks[i] then
            print("[VLKN-CCAM] Error: Missing chunk " .. i .. " for Request ID: " .. tostring(requestId))
            uploadBuffers[src][requestId] = nil -- Cleanup
            return
        end
        table.insert(imageParts, chunks[i])
    end
    
    local fullImage = table.concat(imageParts)
    uploadBuffers[src][requestId] = nil -- Cleanup Memory immediately

    -- Debug: Acknowledge Receipt
    local receiptMsg = "[VLKN-CCAM] Reassembled Image. Size: " .. string.len(fullImage) .. " bytes. Proxying to VPS..."
    print(receiptMsg)
    TriggerClientEvent('vlkn-ccam:clientLog', src, receiptMsg)
    
    if not workerUrl or workerUrl == "" then
        local err = "[VLKN-CCAM] Error: URL missing in proxy request."
        print(err)
        TriggerClientEvent('vlkn-ccam:clientLog', src, err)
        return
    end

    -- Prepare Proxy Payload
    local payload = json.encode({
        image = fullImage, -- Reassembled Base64 String
        ['x-watermark-url'] = data.watermark and data.watermark.Logo,
        ['x-watermark-size'] = data.watermark and data.watermark.LogoSize,
        ['x-watermark-opacity'] = data.watermark and data.watermark.Opacity,
        payload_json = data.webhookPayload
    })

    PerformHttpRequest(workerUrl, function(err, text, headers)
        -- Debug: Log raw response code
        local statusMsg = "[VLKN-CCAM] VPS Responded. Status: " .. tostring(err)
        print(statusMsg)
        TriggerClientEvent('vlkn-ccam:clientLog', src, statusMsg)

        if err ~= 200 then
            local failMsg = "^1[VLKN-CCAM] Proxy Upload Failed: " .. tostring(err) .. " Body: " .. tostring(text) .. "^0"
            print(failMsg)
            TriggerClientEvent('vlkn-ccam:clientLog', src, failMsg)

            -- Notify Client of Failure
            local errMsg = "Upload Failed"
            if text then 
                local decoded = json.decode(text)
                if decoded and decoded.error then errMsg = decoded.error end
            end
            
            TriggerClientEvent('ox_lib:notify', src, {type = 'error', description = errMsg})
        else
            -- Success!
            local responseData = json.decode(text)
            if responseData and responseData.attachments and responseData.attachments[1] then
                 local imgUrl = responseData.attachments[1].url
                 -- Reuse existing logic to notify user
                 TriggerClientEvent('ox_lib:notify', src, {type = 'success', description = 'Screenshot Captured & Uploaded!'})
                 
                 local successMsg = "[VLKN-CCAM] Upload Success! URL: " .. tostring(imgUrl)
                 print(successMsg)
                 TriggerClientEvent('vlkn-ccam:clientLog', src, successMsg)

                 -- Send DM if enabled
                 TriggerEvent('vlkn-freecam:server:capture', imgUrl) 
            else
                 local msg = "[VLKN-CCAM] VPS Success but invalid response format: " .. tostring(text)
                 print(msg)
                 TriggerClientEvent('vlkn-ccam:clientLog', src, msg)
            end
        end
    end, 'POST', payload, { ['Content-Type'] = 'application/json' })
end)
