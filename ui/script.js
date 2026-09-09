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

            menuReady = false;
            setTimeout(() => {
                menuReady = true;
            }, 500);

            document.querySelectorAll('.setting-item').forEach((el, index) => {
                if (index === item.index) {
                    el.classList.add('selected');
                } else {
                    el.classList.remove('selected');
                }
            });

            if (item.data) {
                document.querySelector('#setting-filter .value').innerText = item.data.filter;
                document.querySelector('#setting-bars .value').innerText = item.data.bars ? 'ON' : 'OFF';
                document.querySelector('#setting-minimap .value').innerText = item.data.minimap ? 'VISIBLE' : 'HIDDEN';
            }

        } else {
            panel.style.display = 'none';
            menuReady = false;
        }
    } else if (item.type === 'screenshotMode') {
        const displayVal = item.enabled ? 'none' : 'block';

        document.querySelector('.top-bar').style.display = displayVal;
        document.querySelector('.controls-bar').style.display = displayVal;
        document.querySelector('.reticle').style.display = displayVal;
        document.querySelector('.grid-lines').style.display = displayVal;

        if (item.enabled) {
            document.querySelectorAll('.corner').forEach(el => el.style.display = 'none');
        } else {
            document.querySelectorAll('.corner').forEach(el => el.style.display = '');
        }

    } else if (item.type === 'captureFlash') {
        const flash = document.getElementById('capture-flash');
        if (flash) {
            flash.classList.remove('active');
            void flash.offsetWidth;
            flash.classList.add('active');
        }

    }
});

function editFilter(event) {
    if (event) event.stopPropagation();

    const valueEl = document.querySelector('#setting-filter .value');
    const currentText = valueEl.innerText;

    if (valueEl.querySelector('input')) return;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = parseInt(currentText) || '';
    input.style.width = '70px';
    input.style.background = 'rgba(0,0,0,0.5)';
    input.style.color = 'white';
    input.style.border = '1px solid #ffd500';
    input.style.borderRadius = '0';
    input.style.padding = '2px 5px';
    input.style.outline = 'none';

    valueEl.innerText = '';
    valueEl.appendChild(input);

    input.onclick = (e) => e.stopPropagation();

    fetch(`https://${GetParentResourceName()}/setKeyboardFocus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ focus: true })
    });

    setTimeout(() => {
        input.focus();
        input.select();
    }, 150);

    const finish = () => {
        fetch(`https://${GetParentResourceName()}/setKeyboardFocus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ focus: false })
        });

        const val = parseInt(input.value);
        if (!isNaN(val)) {
            fetch(`https://${GetParentResourceName()}/setFilter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ index: val })
            });
        } else {
            fetch(`https://${GetParentResourceName()}/setFilter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ index: -1 })
            });
        }
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            input.blur();
        }
        if (e.key === 'Escape') {
            input.value = '';
            input.blur();
        }
    });
}
