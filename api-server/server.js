const express = require('express');
const multer = require('multer');
const { Image, decode } = require('imagescript');

// --- CONFIGURATION ---
const PORT = 35500; // Uncommon port
// You can set this via environment variable OR just paste it here for a single-file setup.
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK || '';

// --- SERVER SETUP ---
const app = express();

// Minimal CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// JSON Support (Express 4.16+)
app.use(express.json({ limit: '50mb' }));

// Memory Storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

// --- ROUTES ---
app.get('/', (req, res) => res.json({ status: 'lite-server-online', port: PORT }));

app.post('/api/watermark', upload.single('file'), async (req, res) => {
    let mainImage = null;
    let finalBuffer = null;

    try {
        // --- PARAMS ---
        const body = req.body || {};
        const wmUrl = body['x-watermark-url'];
        const wmSize = parseInt(body['x-watermark-size'] || '200');
        const wmOpacity = parseFloat(body['x-watermark-opacity'] || '0.7');
        const payloadJson = body['payload_json'];

        // --- IMAGE SOURCE CHECK ---
        if (req.file) {
            finalBuffer = req.file.buffer;
        } else if (body.image) {
            // Handle Base64 from Lua Proxy
            // Remove prefix if present (data:image/png;base64,)
            let b64 = body.image;
            if (b64.includes('base64,')) {
                b64 = b64.split('base64,')[1];
            }
            finalBuffer = Buffer.from(b64, 'base64');
        } else {
            return res.status(400).json({ error: 'No file or base64 image provided' });
        }

        // Check Webhook
        if (!WEBHOOK_URL || WEBHOOK_URL.includes('YOUR_DISCORD')) {
            console.error('Webhook not configured!');
            return res.status(500).json({ error: 'Server Webhook Not Configured' });
        }

        // --- ENVIRONMENT CHECK ---
        // Ensure Node 18+ features exist
        if (typeof global.fetch === 'undefined' || typeof global.Blob === 'undefined' || typeof global.FormData === 'undefined') {
            const msg = 'Node.js 18+ is required (Missing fetch/Blob/FormData). Current: ' + process.version;
            console.error(msg);
            return res.status(500).json({ error: msg });
        }

        console.log(`[Lite] Processing ${finalBuffer.length} bytes...`);

        // --- IMAGE PROCESSING ---
        // ImageScript uses async/await 
        // Note: decode() can throw if image is invalid
        if (wmUrl) {
            try {
                // FIXED: Use finalBuffer (works for both File and Base64 source)
                mainImage = await decode(finalBuffer);
                const wmRes = await fetch(wmUrl);
                if (wmRes.ok) {
                    const wmBuf = await wmRes.arrayBuffer();
                    const watermark = await decode(new Uint8Array(wmBuf));

                    // Resize
                    const aspect = watermark.width / watermark.height;
                    watermark.resize(wmSize, Math.round(wmSize / aspect));
                    watermark.opacity(wmOpacity);

                    // Composite (Top Right - Padding 20)
                    mainImage.composite(watermark, mainImage.width - watermark.width - 20, 20);

                    const u8 = await mainImage.encode();
                    finalBuffer = Buffer.from(u8);
                }
            } catch (e) {
                console.error("Watermark Skip:", e.message);
                // Continue with original image if watermark fails
            }
        }

        // --- DISCORD UPLOAD ---
        const form = new FormData();
        const fileBlob = new Blob([finalBuffer], { type: 'image/png' });
        form.append('file', fileBlob, 'screenshot.png');
        if (payloadJson) form.append('payload_json', payloadJson);

        const dRes = await fetch(`${WEBHOOK_URL}?wait=true`, { method: 'POST', body: form });

        if (!dRes.ok) {
            const txt = await dRes.text();
            throw new Error(`Discord ${dRes.status}: ${txt}`);
        }

        const data = await dRes.json();
        console.log(`[Lite] Success! ID: ${data.id}`);
        res.json(data);

    } catch (err) {
        console.error(`[Lite] Error:`, err.message);
        res.status(500).json({ error: err.message });
    } finally {
        // --- AGGRESSIVE CLEANUP ---
        // V8 GC is lazy, so we manually nullify large buffers to encourage it.
        if (req.file) req.file.buffer = null;
        mainImage = null;
        finalBuffer = null;
        if (global.gc) global.gc(); // Only works if run with --expose-gc
    }
});

app.listen(PORT, () => console.log(`Lite Server running on port ${PORT}`));
