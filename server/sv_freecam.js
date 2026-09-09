const https = require('https');
const { URL } = require('url');

// ─── Server-owned configuration ─────────────────────────────────────────────
// The webhook URL, the bot token and the embed are resolved here and are never
// accepted from a client, so a crafted event cannot redirect uploads or forge
// embed content. Override any of these with convars in server.cfg:
//
//   set vlkn_webhook          "https://discord.com/api/webhooks/ID/TOKEN"
//   set vlkn_bot_token        "YOUR_BOT_TOKEN"   // enables DMs; see warning below
//   set vlkn_dm_enabled       "1"                // 0 turns DMs off, token intact
//   set vlkn_embed_title      "Your Photo is Here"
//   set vlkn_embed_color      "rgb(255, 213, 0)"
//   set vlkn_embed_footer     "Samrajya Cam"
//   set vlkn_embed_hint       "Use /ccam"
//   set vlkn_embed_icon       "https://example.com/icon.png"
//   set vlkn_capture_quality  "0.95"
//   set vlkn_capture_encoding "jpg"            // jpg | webp | png
//   set vlkn_channel_name     "#camera-photos"
//
// SECURITY: use `set` for vlkn_webhook and vlkn_bot_token, never `setr`.
// `setr` replicates the value to every connected client.

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (FiveM-Server, 1.0)';

const DEFAULT_ICON = 'https://i.ibb.co/8nk3BJyN/Transparent-Icon.png';
const DEFAULT_TITLE = '\u{1F4F8} Your Photo is Here';
const WEBHOOK_PATTERN = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/i;

// Capture transport. The DDoS filter in front of production strips generic
// HTTP POSTs to the fxserver's file-server port, which breaks screenshot-basic's
// built-in direct upload (the capture hangs forever). Instead the server asks
// the client to shoot via vlkn-ccam:beginCapture, and the frame comes back as
// base64 split into small vlkn-ccam:captureChunk events, reassembled here
// against a single-use token. Keep CAPTURE_CHUNK_SIZE in cl_freecam.lua in sync
// with CAPTURE_CHUNK_SIZE below.

// 0.95 keeps gradients and dark cinematic frames clean. Jpg below ~0.85 bands
// visibly on exactly the shots this camera is used for, and the direct HTTP
// upload makes the extra bytes cheap.
const DEFAULT_QUALITY = 0.95;
const CAPTURE_COOLDOWN_MS = 5000;
const CAPTURE_TIMEOUT_MS = 30000;
// Discord rejects attachments over 10MB on non-boosted servers. Cap locally so
// an oversized capture gets a clear message instead of an opaque HTTP 413.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Event-chunk transport sizing. 4096-char chunks sent at a slow drip keep the
// upload clear of reliable-pipe limits and anticheat burst/rate heuristics.
// Base64 inflates by exactly 4/3, so cap the accepted character total just
// above the image byte cap.
const CAPTURE_CHUNK_SIZE = 4096;
const MAX_CAPTURE_CHUNKS = Math.ceil((MAX_IMAGE_BYTES * 4 / 3 + 65536) / CAPTURE_CHUNK_SIZE);
const MAX_CAPTURE_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64;

// The client strips any data-URI prefix before sending, so the encoding is
// whatever the server asked for - derive mime/extension from it directly
// instead of sniffing.
const ENCODING_META = {
    jpg: { mimeType: 'image/jpeg', extension: 'jpg' },
    png: { mimeType: 'image/png', extension: 'png' },
    webp: { mimeType: 'image/webp', extension: 'webp' }
};

// One in-flight capture per player, keyed by source.
const inFlight = {};
const lastCaptureAt = {};

function isHttpSuccess(status) {
    status = Number(status);
    return status >= 200 && status < 300;
}

function hexToDecimal(color) {
    if (typeof color === 'number') return color;
    if (typeof color !== 'string') return 16766208;

    const rgbMatch = color.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rgbMatch) {
        const r = Math.min(255, parseInt(rgbMatch[1], 10) || 0);
        const g = Math.min(255, parseInt(rgbMatch[2], 10) || 0);
        const b = Math.min(255, parseInt(rgbMatch[3], 10) || 0);
        return (r << 16) | (g << 8) | b;
    }

    const hex = color.replace('#', '').substring(0, 6);
    return parseInt(hex, 16) || 16766208;
}

function notify(src, type, description) {
    emitNet('ox_lib:notify', src, { type, description });
}

// Resolved per send so a convar set after resource start is still picked up.
function resolveWebhook() {
    const raw = GetConvar('vlkn_webhook', '').trim();
    if (!raw) {
        return { error: 'Webhook not configured. Set vlkn_webhook in server.cfg.' };
    }

    const normalized = raw.replace('https://discordapp.com/', 'https://discord.com/');
    if (!WEBHOOK_PATTERN.test(normalized)) {
        return { error: 'vlkn_webhook is not a valid Discord webhook URL.' };
    }

    return { url: normalized };
}

function resolveQuality() {
    const quality = parseFloat(GetConvar('vlkn_capture_quality', String(DEFAULT_QUALITY)));
    if (!Number.isFinite(quality) || quality <= 0 || quality > 1) return DEFAULT_QUALITY;
    return quality;
}

// Default stays 'jpg' deliberately: it is the format people can reuse without
// converting anything. 'webp' is smaller at equal quality, but it downloads as
// a .webp that still trips some editors and upload flows, so it only pays off
// if you care about bytes more than reuse. 'png' is lossless but can blow past
// the 10MB attachment limit at high resolutions.
function resolveEncoding() {
    const encoding = GetConvar('vlkn_capture_encoding', 'jpg').trim().toLowerCase();
    return ['jpg', 'png', 'webp'].includes(encoding) ? encoding : 'jpg';
}

// Server owners write booleans in server.cfg as either 1/0 or true/false, so
// accept both instead of silently ignoring one style. An unset or unrecognised
// value falls back to fallbackValue.
function resolveConvarBool(name, fallbackValue) {
    const raw = GetConvar(name, '').trim().toLowerCase();
    if (!raw) return fallbackValue;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return fallbackValue;
}

// ─── Embed construction ─────────────────────────────────────────────────────
// The embed itself is shared by the webhook post and the DM so both always look
// identical. Only the wrapper differs: username/avatar_url are webhook-only
// fields and a bot message ignores them.

function buildEmbed(fileName) {
    const footer = GetConvar('vlkn_embed_footer', 'Samrajya Cam');
    const hint = GetConvar('vlkn_embed_hint', 'Use /ccam');
    const icon = GetConvar('vlkn_embed_icon', DEFAULT_ICON);

    // Only the footer carries the command hint - the webhook username stays the
    // plain brand name so the hint does not leak into the bot's display name.
    // This server script cannot read Config.CommandName (that is a Lua global in
    // a different runtime), so keep vlkn_embed_hint in sync if you rename /ccam.
    const footerText = [footer, hint].filter(Boolean).join(' • ');

    const embed = {
        title: GetConvar('vlkn_embed_title', DEFAULT_TITLE),
        color: hexToDecimal(GetConvar('vlkn_embed_color', 'rgb(255, 213, 0)')),
        image: { url: `attachment://${fileName}` }
    };

    if (footerText) {
        embed.footer = icon ? { text: footerText, icon_url: icon } : { text: footerText };
    }

    return embed;
}

function buildPayload(fileName) {
    const footer = GetConvar('vlkn_embed_footer', 'Samrajya Cam');
    const icon = GetConvar('vlkn_embed_icon', DEFAULT_ICON);

    const payload = {
        username: footer || 'Samrajya Cam',
        embeds: [buildEmbed(fileName)],
        attachments: [{ id: 0, filename: fileName }]
    };

    if (icon) payload.avatar_url = icon;

    return payload;
}

function buildDmPayload(fileName) {
    return {
        embeds: [buildEmbed(fileName)],
        attachments: [{ id: 0, filename: fileName }]
    };
}

function buildMultipart(payload, image, fileName) {
    const boundary = '----VLKNCCAM' + Date.now() + Math.floor(Math.random() * 100000);

    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
        'utf8'
    );
    const payloadJsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const fileHead = Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`,
        'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    return {
        contentType: `multipart/form-data; boundary=${boundary}`,
        body: Buffer.concat([head, payloadJsonBuf, fileHead, image.buffer, tail])
    };
}

// cb(err, statusCode, responseText). Never called more than once.
function httpsPost(url, headers, body, cb) {
    let settled = false;
    const finish = (err, status, text) => {
        if (settled) return;
        settled = true;
        cb(err, status, text);
    };

    try {
        const req = https.request(new URL(url), { method: 'POST', headers }, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => finish(null, res.statusCode, responseData));
        });

        req.on('error', err => finish(err));
        req.write(body);
        req.end();
    } catch (err) {
        finish(err);
    }
}

// ─── Webhook delivery ───────────────────────────────────────────────────────

function sendDiscordWebhook(src, image, done) {
    const finish = () => { if (typeof done === 'function') done(); };

    const hook = resolveWebhook();
    if (hook.error) {
        console.error(`^1[VLKN-CCAM] ${hook.error}^0`);
        notify(src, 'error', 'Discord webhook not configured!');
        finish();
        return;
    }

    const fileName = `screenshot.${image.extension}`;
    const multipart = buildMultipart(buildPayload(fileName), image, fileName);
    const urlStr = hook.url.includes('?') ? `${hook.url}&wait=true` : `${hook.url}?wait=true`;

    httpsPost(urlStr, {
        'Content-Type': multipart.contentType,
        'Content-Length': multipart.body.length,
        'User-Agent': USER_AGENT
    }, multipart.body, (err, status, text) => {
        if (err) {
            console.error(`^1[VLKN-CCAM] Network request error: ${err.message}^0`);
            notify(src, 'error', 'Network request error');
            finish();
            return;
        }

        if (isHttpSuccess(status)) {
            const channel = GetConvar('vlkn_channel_name', '#camera-photos');
            console.log(`^2[VLKN-CCAM] [2/2] Embed posted to Discord for player ${src} (Status: ${status})^0`);
            notify(src, 'success', `Photo sent to ${channel}!`);
            emitNet('vlkn-ccam:uploadSuccess', src, channel);
        } else {
            console.error(`^1[VLKN-CCAM] Error sending webhook image. Status: ${status} Body: ${text}^0`);
            notify(src, 'error', `Upload Failed (${status})`);
        }

        finish();
    });
}

// ─── Direct message delivery ────────────────────────────────────────────────
// Two gates must both pass: vlkn_dm_enabled (on by default, so configuring a
// token is enough to get DMs) and a non-empty vlkn_bot_token. The toggle exists
// so DMs can be switched off without dropping the token out of server.cfg.
// Sending a DM takes two calls: open (or fetch) the DM channel for the
// recipient, then post the same embed into it. A DM failure is always non-fatal
// - the webhook post is the primary destination and has already happened by
// this point.

// Resolved per capture so flipping the convar takes effect without a restart.
// Silent when off: a disabled feature should not log or notify per capture.
function dmActive() {
    if (!resolveConvarBool('vlkn_dm_enabled', true)) return false;
    return GetConvar('vlkn_bot_token', '').trim() !== '';
}

function getDiscordId(src) {
    const count = GetNumPlayerIdentifiers(String(src));
    for (let i = 0; i < count; i++) {
        const identifier = GetPlayerIdentifier(String(src), i);
        if (identifier && identifier.startsWith('discord:')) {
            return identifier.substring('discord:'.length);
        }
    }
    return null;
}

// Never include the token in these strings.
function describeDmFailure(status, text) {
    if (status === 401) return 'bot token was rejected - check vlkn_bot_token';
    if (status === 403) return 'bot lacks permission to DM this user';
    if (status === 429) return 'rate limited by Discord';
    if (text && text.includes('50007')) {
        return 'recipient has DMs closed, or shares no server with the bot';
    }
    return `HTTP ${status} ${text || ''}`.trim();
}

function sendDiscordDM(src, discordId, image) {
    if (!dmActive()) return; // Toggled off, or no token configured.

    const token = GetConvar('vlkn_bot_token', '').trim();

    if (!discordId) {
        console.log(`^3[VLKN-CCAM] No discord: identifier for player ${src}; skipping DM.^0`);
        notify(src, 'inform', 'Could not DM your photo: Discord not detected.');
        return;
    }

    const authHeaders = {
        'Authorization': `Bot ${token}`,
        'User-Agent': USER_AGENT
    };

    const channelBody = Buffer.from(JSON.stringify({ recipient_id: discordId }), 'utf8');

    httpsPost(`${DISCORD_API}/users/@me/channels`, {
        ...authHeaders,
        'Content-Type': 'application/json',
        'Content-Length': channelBody.length
    }, channelBody, (err, status, text) => {
        if (err) {
            console.error(`^1[VLKN-CCAM] DM channel request failed for player ${src}: ${err.message}^0`);
            return;
        }

        if (!isHttpSuccess(status)) {
            console.error(`^1[VLKN-CCAM] Could not open a DM channel for player ${src}: ${describeDmFailure(status, text)}^0`);
            notify(src, 'inform', 'Could not DM your photo. Check your Discord privacy settings.');
            return;
        }

        let channelId = null;
        try {
            channelId = JSON.parse(text).id;
        } catch (parseErr) {
            channelId = null;
        }

        if (!channelId) {
            console.error(`^1[VLKN-CCAM] Discord returned no DM channel id for player ${src}.^0`);
            return;
        }

        const fileName = `screenshot.${image.extension}`;
        const multipart = buildMultipart(buildDmPayload(fileName), image, fileName);

        httpsPost(`${DISCORD_API}/channels/${channelId}/messages`, {
            ...authHeaders,
            'Content-Type': multipart.contentType,
            'Content-Length': multipart.body.length
        }, multipart.body, (dmErr, dmStatus, dmText) => {
            if (dmErr) {
                console.error(`^1[VLKN-CCAM] DM send failed for player ${src}: ${dmErr.message}^0`);
                return;
            }

            if (isHttpSuccess(dmStatus)) {
                console.log(`^2[VLKN-CCAM] Photo DM'd to player ${src} (discord ${discordId}).^0`);
                notify(src, 'success', 'Photo also sent to your Discord DMs!');
            } else {
                console.error(`^1[VLKN-CCAM] DM send failed for player ${src}: ${describeDmFailure(dmStatus, dmText)}^0`);
                notify(src, 'inform', 'Could not DM your photo. Check your Discord privacy settings.');
            }
        });
    });
}

// ─── Capture flow ───────────────────────────────────────────────────────────

// Single-use token echoed back on every chunk so a stale or spoofed chunk
// stream from another capture can never be stitched into this one. Built from
// Math.random to avoid any dependency on the crypto builtin across runtimes.
function randomToken() {
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
}

// Releases the per-player lock and lets the client restore its controls.
function finishCapture(src) {
    const state = inFlight[src];
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    delete inFlight[src];
    emitNet('vlkn-ccam:captureDone', src);
}

// All chunks are in: decode, validate size, and hand off to Discord. Mirrors
// the old requestClientScreenshot callback body.
function completeCapture(src, state, base64) {
    const meta = ENCODING_META[state.encoding] || ENCODING_META.jpg;
    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length) {
        console.error(`^1[VLKN-CCAM] Failed to convert base64 image to buffer for player ${src}.^0`);
        notify(src, 'error', 'Failed to process screenshot data.');
        finishCapture(src);
        return;
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
        console.error(`^1[VLKN-CCAM] Rejected capture from player ${src}: ${buffer.length} bytes exceeds Discord's ${MAX_IMAGE_BYTES} byte limit. Lower vlkn_capture_quality.^0`);
        notify(src, 'error', 'Screenshot too large - lower the capture quality.');
        finishCapture(src);
        return;
    }

    const image = { buffer, mimeType: meta.mimeType, extension: meta.extension };

    // Read before finishCapture clears the in-flight record.
    const discordId = state.discordId;

    sendDiscordWebhook(src, image, () => {
        // Controls come back as soon as the channel post lands; the DM
        // then runs on its own and never holds up the player.
        finishCapture(src);
        sendDiscordDM(src, discordId, image);
    });
}

// Client -> server events are registered by server/sv_bridge.lua (WaveShield
// only recognizes Lua registrations) and forwarded into these exports. `src`
// is always passed in explicitly from the bridge.

exports('wsRequestCapture', (src) => {
    const now = Date.now();

    if (inFlight[src]) {
        console.log(`^3[VLKN-CCAM] Ignoring capture from player ${src}: previous one still in flight.^0`);
        notify(src, 'error', 'Still uploading your last photo.');
        // Answer anyway. Staying silent here is what strands a client whose own
        // watchdog already expired: it thinks it is idle, we think it is busy,
        // and it would sit through another full watchdog with no reply.
        emitNet('vlkn-ccam:captureDone', src);
        return;
    }

    if (now - (lastCaptureAt[src] || 0) < CAPTURE_COOLDOWN_MS) {
        console.log(`^3[VLKN-CCAM] Ignoring capture from player ${src}: cooldown.^0`);
        notify(src, 'error', 'Slow down - one photo at a time.');
        emitNet('vlkn-ccam:captureDone', src);
        return;
    }

    // Checked before the shutter so a misconfigured webhook never costs a photo.
    const hook = resolveWebhook();
    if (hook.error) {
        console.error(`^1[VLKN-CCAM] ${hook.error}^0`);
        notify(src, 'error', 'Discord webhook not configured!');
        emitNet('vlkn-ccam:captureDone', src);
        return;
    }

    lastCaptureAt[src] = now;

    const captureId = randomToken();
    const encoding = resolveEncoding();

    inFlight[src] = {
        captureId,
        encoding,
        chunks: null,
        totalChunks: 0,
        receivedChars: 0,
        // Resolved now, while the player is definitely still connected - their
        // identifiers are gone by the time the DM fires if they disconnect.
        // Skipped when DMs are off so the lookup costs nothing.
        discordId: dmActive() ? getDiscordId(src) : null,
        timer: setTimeout(() => {
            console.error(`^3[VLKN-CCAM] Capture from player ${src} timed out after ${CAPTURE_TIMEOUT_MS}ms.^0`);
            notify(src, 'error', 'Upload timed out, please try again.');
            finishCapture(src);
        }, CAPTURE_TIMEOUT_MS)
    };

    console.log(`^2[VLKN-CCAM] [1/2] Requesting capture from player ${src}...^0`);

    emitNet('vlkn-ccam:beginCapture', src, {
        captureId,
        encoding,
        quality: resolveQuality()
    });
});

exports('wsCaptureChunk', (src, captureId, index, total, chunk) => {
    const state = inFlight[src];
    if (!state || typeof captureId !== 'string' || captureId !== state.captureId) return;

    // The first chunk seen fixes the total; later chunks must agree.
    if (!state.chunks) {
        if (!Number.isInteger(total) || total < 1 || total > MAX_CAPTURE_CHUNKS) return;
        state.chunks = new Array(total).fill(null);
        state.totalChunks = total;
        console.log(`^3[VLKN-CCAM] Receiving ${total} chunks from player ${src}...^0`);
    } else if (total !== state.totalChunks) {
        return;
    }

    if (!Number.isInteger(index) || index < 0 || index >= state.totalChunks) return;
    if (typeof chunk !== 'string' || !chunk.length || chunk.length > CAPTURE_CHUNK_SIZE) return;
    if (state.chunks[index] !== null) return; // duplicate retransmit

    state.receivedChars += chunk.length;
    if (state.receivedChars > MAX_CAPTURE_CHARS) {
        console.error(`^1[VLKN-CCAM] Rejected oversized upload from player ${src}.^0`);
        notify(src, 'error', 'Screenshot too large - lower the capture quality.');
        finishCapture(src);
        return;
    }

    state.chunks[index] = chunk;

    if (!state.chunks.includes(null)) {
        const base64 = state.chunks.join('');
        state.chunks = null;
        completeCapture(src, state, base64);
    }
});

exports('wsCaptureAborted', (src, captureId) => {
    const state = inFlight[src];
    if (!state || typeof captureId !== 'string' || captureId !== state.captureId) return;

    console.log(`^3[VLKN-CCAM] Capture aborted client-side for player ${src}.^0`);
    notify(src, 'inform', 'Screenshot service unavailable.');
    finishCapture(src);
});

console.log('^2[VLKN-CCAM] sv_freecam.js loaded - chunked capture transport ready.^0');

on('playerDropped', () => {
    const src = global.source;
    const state = inFlight[src];
    if (state) {
        if (state.timer) clearTimeout(state.timer);
        delete inFlight[src];
    }
    delete lastCaptureAt[src];
});
