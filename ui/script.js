let menuReady = false; // Debounce flag

function closeSettings() {
    // Hide panel immediately for responsiveness, Lua will confirm
    document.getElementById('settings-panel').style.display = 'none';
    fetch(`https://${GetParentResourceName()}/closeMenu`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({})
    });
}

// Key listeners removed - handled by Lua for better game integration


window.addEventListener('message', function (event) {
    const item = event.data;

    if (item.type === 'ui') {
        const container = document.getElementById('container');
        if (item.display) {
            container.style.display = 'block';
        } else {
            container.style.display = 'none';
        }
    } else if (item.type === 'update') {
        if (item.zoom) {
            // Calculate magnification factor based on a standard FOV of 50.0
            // Zooming IN (lower FOV) -> Higher Zoom X
            // Zooming OUT (higher FOV) -> Lower Zoom X
            let zoomFactor = 50.0 / item.zoom;
            document.getElementById('zoom-level').innerText = zoomFactor.toFixed(2) + 'X ZOOM';
        }
    } else if (item.type === 'keypress') {
        const key = document.querySelector(`.key[data-key="${item.key}"]`);
        if (key) {
            if (item.active) {
                key.classList.add('active');
            } else {
                key.classList.remove('active');
            }
        }
    } else if (item.type === 'settings') {
        const panel = document.getElementById('settings-panel');
        if (item.show) {
            panel.style.display = 'block';

            // Debounce 'O' key to prevent immediate closing on release
            menuReady = false;
            setTimeout(() => {
                menuReady = true;
            }, 500);

            // Update items selection
            document.querySelectorAll('.setting-item').forEach((el, index) => {
                if (index === item.index) {
                    el.classList.add('selected');
                } else {
                    el.classList.remove('selected');
                }
            });

            // Update values
            if (item.data) {
                document.querySelector('#setting-filter .value').innerText = item.data.filter;
                document.querySelector('#setting-bars .value').innerText = item.data.bars ? 'ON' : 'OFF';
                document.querySelector('#setting-minimap .value').innerText = item.data.minimap ? 'VISIBLE' : 'HIDDEN';
            }

        } else {
            panel.style.display = 'none';
            menuReady = false;
        }
    } else if (item.type === 'watermark') {
        const wm = document.getElementById('watermark');
        if (item.show !== undefined) {
            // Preload logic: Always display block, but control opacity
            if (item.src) wm.src = item.src;

            // Store target opacity
            const targetOp = item.opacity || 0.3;
            wm.dataset.targetOpacity = targetOp;

            // Initial State: user requested HIDDEN (show=false), so 0. 
            // If show=true (unlikely default now), use target.
            wm.style.opacity = item.show ? targetOp : '0';

            wm.style.width = item.width || '100px';
            wm.style.display = 'block'; // Always in DOM to load image

            // Reset positioning
            wm.style.top = 'auto'; wm.style.bottom = 'auto';
            wm.style.left = 'auto'; wm.style.right = 'auto';

            // Apply Position
            const pos = item.position || 'top-right';
            if (pos.includes('top')) wm.style.top = '20px';
            if (pos.includes('bottom')) wm.style.bottom = '20px';
            if (pos.includes('left')) wm.style.left = '20px';
            if (pos.includes('right')) wm.style.right = '20px';
        }
    } else if (item.type === 'screenshotMode') {
        const displayVal = item.enabled ? 'none' : 'block';  // Hide controls if Capture

        document.querySelector('.top-bar').style.display = displayVal;
        document.querySelector('.controls-bar').style.display = displayVal;
        document.querySelector('.reticle').style.display = displayVal;
        document.querySelector('.grid-lines').style.display = displayVal;

        // Fix: Do NOT force corners to show if they are hidden by CSS default
        // Only hide them if we are entering screenshot mode. Upon exit, we revert to CSS (via empty string) or just don't touch if hidden.
        if (item.enabled) {
            document.querySelectorAll('.corner').forEach(el => el.style.display = 'none');
        } else {
            // If restoring controls, we only restore corners if they are SUPPOSED to be visible. 
            // Since CSS sets them to none, we just remove the inline style to let CSS take over.
            document.querySelectorAll('.corner').forEach(el => el.style.display = '');
        }

        // Toggle Watermark visibility via Opacity
        const wm = document.getElementById('watermark');
        if (wm) {
            // Force display block to ensure it participates in layout
            wm.style.display = 'block';

            // If capturing (enabled=true), snap to target opacity. Else snap to 0.
            const target = wm.dataset.targetOpacity || 0.3;
            wm.style.opacity = item.enabled ? target : '0';
        }

    } else if (item.type === 'perform_capture') {
        console.log('[UI] Perform Capture Triggered'); // DEBUG
        // CLIENT-SIDE COMPOSITION & UPLOAD
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (item.workerUrl) {
            console.log('[UI] Using Worker URL:', item.workerUrl); // DEBUG
            // --- WORKER PATH (Proxy) ---
            // OPTIMIZATION: We already have the Base64 string from Lua. 
            // We don't need to convert it to a Blob and back to Base64 for the Proxy.
            // Just pass the string directly.
            uploadWorker(item.base64, item.workerUrl, item.embed, item.watermark, item.notifyLog);
        } else {
            // --- LOCAL CANVAS PATH (High Memory) ---
            const img = new Image();
            img.onload = function () {
                // Set canvas size to match screenshot
                canvas.width = img.width;
                canvas.height = img.height;

                // 1. Draw Game Screenshot
                ctx.drawImage(img, 0, 0);

                // 2. Draw Watermark (if configured)
                if (item.watermark && item.watermark.Logo) {
                    const wmImg = new Image();
                    wmImg.crossOrigin = "Anonymous"; // Try to allow cross-origin
                    wmImg.onload = function () {
                        drawWatermark(ctx, wmImg, canvas.width, canvas.height, item.watermark);
                        uploadCanvas(canvas, item.webhook, item.notifyLog, item.embed);
                    };
                    wmImg.onerror = function () {
                        console.log('Watermark failed to load, uploading raw screenshot');
                        uploadCanvas(canvas, item.webhook, item.notifyLog, item.embed);
                    };
                    wmImg.src = item.watermark.Logo;
                } else {
                    uploadCanvas(canvas, item.webhook, item.notifyLog, item.embed);
                }
            };
            img.src = item.base64;
        }
    }
});

function uploadWorker(imageInput, workerUrl, embedConfig, watermarkConfig, notifyLog) {
    // Helper to proceed once we have the base64 string
    const processUpload = (base64data) => {
        console.log('[UI] Processing Upload with Base64 length:', base64data && base64data.length); // DEBUG

        // Construct Payload for Discord
        const payload = {
            username: "VLKN Freecam",
            avatar_url: embedConfig ? embedConfig.FooterIcon : ""
        };

        if (embedConfig) {
            let colorDec = 3447003;
            if (embedConfig.Color) {
                const hex = embedConfig.Color.replace('#', '').substring(0, 6);
                colorDec = parseInt(hex, 16);
            }

            const embed = {
                title: embedConfig.Title || "📸 Your Screenshot",
                color: colorDec,
                image: { url: "attachment://screenshot.png" }, // Referenced in server upload
                footer: {
                    text: embedConfig.Footer || "VLKN Freecam",
                    icon_url: embedConfig.FooterIcon
                },
                timestamp: new Date().toISOString()
            };
            payload.embeds = [embed];
        }

        // Send to Client Lua to Pivot to Server Lua (Proxy)
        // This avoids Mixed Content warnings since the NUI is Secure Context and VPS is HTTP
        fetch(`https://${GetParentResourceName()}/uploadToVPSProxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({
                workerUrl: workerUrl,
                image: base64data,
                webhookPayload: JSON.stringify(payload),
                watermark: watermarkConfig,
                notifyLog: notifyLog
            })
        })
            .then(res => res.json())
            .then(data => {
                console.log("Handed off to Lua Proxy:", data); // DEBUG
            }).catch(err => {
                console.error("Lua Proxy Error:", err);
            });
    };

    // Handle Input Type (Blob vs String)
    if (typeof imageInput === 'string') {
        processUpload(imageInput);
    } else {
        // Convert Blob to Base64 (Old path or fallback)
        const reader = new FileReader();
        reader.readAsDataURL(imageInput);
        reader.onloadend = function () {
            processUpload(reader.result);
        }
    }
}

function drawWatermark(ctx, img, cw, ch, config) {
    ctx.globalAlpha = config.Opacity || 0.5;

    // Use Configured Size (Width) and Auto-Calculate Height
    const w = config.size || 200;

    // Check for valid dimensions to prevent division by zero or NaN
    const aspect = (img.width && img.height) ? (img.width / img.height) : 1;
    const h = w / aspect;

    let x = 20, y = 20;
    const padding = 30;

    const pos = config.Position || 'top-right';

    if (pos.includes('right')) x = cw - w - padding;
    else x = padding; // left

    if (pos.includes('bottom')) y = ch - h - padding;
    else y = padding; // top

    ctx.drawImage(img, x, y, w, h);
    ctx.globalAlpha = 1.0; // Reset
}

function uploadCanvas(canvas, webhook, notifyLog, embedConfig) {
    canvas.toBlob(function (blob) {
        const formData = new FormData();
        formData.append('file', blob, 'screenshot.png');

        // Construct Discord Payload for Embed
        const payload = {
            username: "VLKN Freecam",
            avatar_url: embedConfig ? embedConfig.FooterIcon : ""
        };

        if (embedConfig) {
            // Convert Hex Color (e.g. #9500ffff) to Decimal Integer
            let colorDec = 3447003; // Default Blue
            if (embedConfig.Color) {
                const hex = embedConfig.Color.replace('#', '').substring(0, 6);
                colorDec = parseInt(hex, 16);
            }

            payload.embeds = [{
                title: embedConfig.Title || "📸 Your Screenshot",
                color: colorDec,
                image: { url: "attachment://screenshot.png" }, // Reference the uploaded file
                footer: {
                    text: embedConfig.Footer || "VLKN Freecam",
                    icon_url: embedConfig.FooterIcon
                },
                timestamp: new Date().toISOString()
            }];
        } else {
            // Fallback content if no embed config
            payload.content = "📸 **New Screenshot Captured**";
        }

        // Append JSON Payload
        formData.append('payload_json', JSON.stringify(payload));

        // Append ?wait=true to get the message object back (with URL)
        const uploadUrl = webhook.includes('?') ? webhook + '&wait=true' : webhook + '?wait=true';

        fetch(uploadUrl, {
            method: 'POST',
            body: formData
        })
            .then(response => response.json()) // Parse JSON response
            .then(data => {
                if (data && data.attachments && data.attachments[0]) {
                    const imgUrl = data.attachments[0].url;

                    // Notify Lua with Success and URL
                    const msg = notifyLog ? 'Screenshot sent to Discord Channel!' : 'Screenshot Captured!';

                    fetch(`https://${GetParentResourceName()}/notify_capture`, {
                        method: 'POST',
                        body: JSON.stringify({
                            success: true,
                            message: msg,
                            url: imgUrl
                        })
                    });
                } else {
                    console.error('Webhook Upload Failed or No Attachments returned');
                    fetch(`https://${GetParentResourceName()}/notify_capture`, {
                        method: 'POST',
                        body: JSON.stringify({ success: false, message: 'Upload Failed' })
                    });
                }
            })
            .catch(err => {
                console.error('Upload Error:', err);
                fetch(`https://${GetParentResourceName()}/notify_capture`, {
                    method: 'POST',
                    body: JSON.stringify({ success: false, message: 'Upload Error' })
                });
            });
    }, 'image/png');
}

function editFilter(event) {
    if (event) event.stopPropagation();

    // Only allow editing if the filter item is actually selected/visible or generally whenever clicked
    const valueEl = document.querySelector('#setting-filter .value');
    const currentText = valueEl.innerText;

    // Prevent double input
    if (valueEl.querySelector('input')) return;

    // Create Input
    const input = document.createElement('input');
    input.type = 'number';
    input.value = parseInt(currentText) || ''; // Try to get number, else empty
    input.style.width = '70px';
    input.style.background = 'rgba(0,0,0,0.5)';
    input.style.color = 'white';
    input.style.border = '1px solid #00bfd0';
    input.style.borderRadius = '0'; /* Square as requested */
    input.style.padding = '2px 5px';
    input.style.outline = 'none';

    // Replace text with input
    valueEl.innerText = '';
    valueEl.appendChild(input);

    // Prevent clicking THE INPUT from closing/bubbling
    input.onclick = (e) => e.stopPropagation();

    // Request Keyboard Focus FIRST
    fetch(`https://${GetParentResourceName()}/setKeyboardFocus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ focus: true })
    });

    // Focus with delay to ensure NUI has control
    // Increased delay slightly to be safe
    setTimeout(() => {
        input.focus();
        input.select();
    }, 150);

    // Handle Input Confirmation
    const finish = () => {
        // Release Keyboard Focus
        fetch(`https://${GetParentResourceName()}/setKeyboardFocus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ focus: false })
        });

        const val = parseInt(input.value);
        if (!isNaN(val)) {
            // Send to Lua
            fetch(`https://${GetParentResourceName()}/setFilter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ index: val })
            });
        } else {
            // Reset if invalid
            // We wait for Lua update anyway, but clean up UI
            fetch(`https://${GetParentResourceName()}/setFilter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ index: -1 }) // Sentinel for "Just Refresh" or invalid
            });
        }
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // Standardize key behavior
        if (e.key === 'Enter') {
            input.blur();
        }
        if (e.key === 'Escape') {
            // Cancel edit
            input.value = ''; // Force invalid
            input.blur();
        }
    });
}
