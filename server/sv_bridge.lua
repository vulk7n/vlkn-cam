-- WaveShield compatibility bridge.
--
-- WaveShield's event protection only recognizes events registered from *Lua*
-- server scripts (their docs: event protection "is only working for LUA
-- scripts at the moment"). This resource's capture logic lives in JavaScript,
-- so every client -> server trigger was classified as an unknown event and
-- silently dropped - the capture hung forever at "Requesting capture".
--
-- This file registers the same event names in Lua and forwards each one into
-- the JS implementation via exports. Event names and payloads stay identical,
-- so the client script needs no changes.

local RESOURCE = GetCurrentResourceName()

RegisterNetEvent('vlkn-ccam:requestCapture')
AddEventHandler('vlkn-ccam:requestCapture', function()
    exports[RESOURCE]:wsRequestCapture(source)
end)

RegisterNetEvent('vlkn-ccam:captureChunk')
AddEventHandler('vlkn-ccam:captureChunk', function(captureId, index, total, chunk)
    exports[RESOURCE]:wsCaptureChunk(source, captureId, index, total, chunk)
end)

RegisterNetEvent('vlkn-ccam:captureAborted')
AddEventHandler('vlkn-ccam:captureAborted', function(captureId)
    exports[RESOURCE]:wsCaptureAborted(source, captureId)
end)
