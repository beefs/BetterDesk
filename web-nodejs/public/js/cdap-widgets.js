/**
 * BetterDesk Console - CDAP Widget Renderer
 * Renders device widgets based on CDAP manifest and polls state updates.
 * Supports Phase 2 widget types: toggle, gauge, button, led, text, slider, select, chart.
 */

(function () {
    'use strict';

    const __ = window.BetterDesk?.translations || {};
    const t = (key) => {
        const parts = key.split('.');
        let val = __;
        for (const p of parts) {
            val = val?.[p];
        }
        return val || key;
    };

    const STATE_POLL_INTERVAL = 3000;
    const INFO_POLL_INTERVAL = 10000;

    let deviceId = '';
    let manifest = null;
    let widgetState = {};
    let statePollTimer = null;
    let infoPollTimer = null;
    let isConnected = false;

    // ── Initialization ───────────────────────────────────────────────────

    function init() {
        const page = document.querySelector('.cdap-device-page');
        if (!page) return;

        deviceId = page.dataset.deviceId;
        if (!deviceId) return;

        loadDeviceInfo();
        loadManifestAndState();
    }

    async function loadDeviceInfo() {
        try {
            const res = await fetch(`/api/cdap/devices/${encodeURIComponent(deviceId)}`, {
                headers: { 'X-CSRF-Token': window.BetterDesk?.csrfToken || '' }
            });
            if (!res.ok) throw new Error(res.statusText);
            const data = await res.json();

            if (data.success && data.data) {
                updateDeviceHeader(data.data);
            }
        } catch (err) {
            console.error('CDAP device info error:', err);
        }

        // Schedule periodic info refresh
        if (!infoPollTimer) {
            infoPollTimer = setInterval(loadDeviceInfo, INFO_POLL_INTERVAL);
        }
    }

    function updateDeviceHeader(info) {
        isConnected = !!info.connected;

        // Device name (prefer manifest name or hostname)
        const nameEl = document.getElementById('cdap-device-name');
        if (nameEl) {
            nameEl.textContent = info.manifest?.device?.name || info.hostname || deviceId;
        }

        // Device type
        const typeEl = document.getElementById('cdap-device-type');
        if (typeEl && info.manifest?.device?.type) {
            const iconMap = {
                scada: 'factory',
                iot: 'sensors',
                os_agent: 'computer',
                network: 'router',
                camera: 'videocam',
                desktop: 'desktop_windows',
                custom: 'memory'
            };
            const icon = iconMap[info.manifest.device.type] || 'memory';
            typeEl.innerHTML = `<span class="material-icons">${icon}</span><span>${info.manifest.device.type}</span>`;
        }

        // Version
        const verEl = document.getElementById('cdap-device-version');
        if (verEl && info.manifest?.device?.firmware_version) {
            verEl.innerHTML = `<span class="material-icons">info_outline</span><span>v${escapeHtml(info.manifest.device.firmware_version)}</span>`;
        }

        // Uptime
        const uptimeEl = document.getElementById('cdap-device-uptime');
        if (uptimeEl && info.connected_at) {
            const uptime = formatDuration(Date.now() - new Date(info.connected_at).getTime());
            uptimeEl.innerHTML = `<span class="material-icons">schedule</span><span>${uptime}</span>`;
        }

        // Status indicator
        const statusEl = document.getElementById('cdap-device-status');
        if (statusEl) {
            statusEl.className = `cdap-device-status ${isConnected ? 'online' : 'offline'}`;
            statusEl.innerHTML = `
                <span class="cdap-status-dot"></span>
                <span class="cdap-status-text">${isConnected ? t('cdap.connected') : t('cdap.disconnected')}</span>
            `;
        }

        // Offline banner
        const banner = document.getElementById('cdap-offline-banner');
        if (banner) {
            banner.classList.toggle('hidden', isConnected);
        }
    }

    async function loadManifestAndState() {
        const loading = document.getElementById('cdap-loading');
        const grid = document.getElementById('cdap-widget-grid');
        const empty = document.getElementById('cdap-empty');

        try {
            // Fetch manifest and state in parallel
            const [manifestRes, stateRes] = await Promise.all([
                fetch(`/api/cdap/devices/${encodeURIComponent(deviceId)}/manifest`, {
                    headers: { 'X-CSRF-Token': window.BetterDesk?.csrfToken || '' }
                }),
                fetch(`/api/cdap/devices/${encodeURIComponent(deviceId)}/state`, {
                    headers: { 'X-CSRF-Token': window.BetterDesk?.csrfToken || '' }
                })
            ]);

            if (manifestRes.ok) {
                const mData = await manifestRes.json();
                if (mData.success) manifest = mData.data;
            }

            if (stateRes.ok) {
                const sData = await stateRes.json();
                if (sData.success) widgetState = sData.data || {};
            }

            if (loading) loading.classList.add('hidden');

            if (!manifest || !manifest.widgets || manifest.widgets.length === 0) {
                if (empty) empty.classList.remove('hidden');
                return;
            }

            renderWidgets();
            startStatePolling();

        } catch (err) {
            console.error('CDAP manifest/state error:', err);
            if (loading) {
                loading.innerHTML = `<p class="cdap-error">${t('cdap.load_error')}</p>`;
            }
        }
    }

    // ── Widget Rendering ─────────────────────────────────────────────────

    function renderWidgets() {
        const grid = document.getElementById('cdap-widget-grid');
        if (!grid || !manifest?.widgets) return;

        // Remove loading state
        const loading = document.getElementById('cdap-loading');
        if (loading) loading.remove();

        // Group widgets by category if categories exist
        const widgets = manifest.widgets;
        const grouped = groupByCategory(widgets);

        let html = '';
        for (const [category, catWidgets] of Object.entries(grouped)) {
            if (category !== '_default') {
                html += `<div class="cdap-widget-category"><h3>${escapeHtml(category)}</h3></div>`;
            }
            for (const widget of catWidgets) {
                html += renderWidget(widget);
            }
        }

        grid.innerHTML = html;

        // Apply initial state values
        applyState(widgetState);

        // Show command log if any interactive widgets
        const hasInteractive = widgets.some(w =>
            ['toggle', 'button', 'slider', 'select'].includes(w.type)
        );
        if (hasInteractive) {
            const log = document.getElementById('cdap-command-log');
            if (log) log.classList.remove('hidden');
        }

        // Bind widget event handlers
        bindWidgetEvents();
    }

    function groupByCategory(widgets) {
        const groups = {};
        for (const w of widgets) {
            const cat = w.category || '_default';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(w);
        }
        return groups;
    }

    function renderWidget(widget) {
        const { id, type, label, unit, read_only } = widget;
        const safeId = escapeHtml(id);
        const safeLabel = escapeHtml(label || id);
        const readOnlyClass = read_only ? ' cdap-widget-readonly' : '';

        const sizeClass = getWidgetSizeClass(type, widget);

        let inner = '';
        switch (type) {
            case 'toggle':
                inner = renderToggle(widget);
                break;
            case 'gauge':
                inner = renderGauge(widget);
                break;
            case 'button':
                inner = renderButton(widget);
                break;
            case 'led':
                inner = renderLed(widget);
                break;
            case 'text':
                inner = renderText(widget);
                break;
            case 'slider':
                inner = renderSlider(widget);
                break;
            case 'select':
                inner = renderSelect(widget);
                break;
            case 'chart':
                inner = renderChart(widget);
                break;
            default:
                inner = `<div class="cdap-widget-unsupported">${escapeHtml(type)}</div>`;
        }

        return `
            <div class="cdap-widget ${sizeClass}${readOnlyClass}" data-widget-id="${safeId}" data-widget-type="${escapeHtml(type)}">
                <div class="cdap-widget-header">
                    <span class="cdap-widget-label">${safeLabel}</span>
                    ${unit ? `<span class="cdap-widget-unit">${escapeHtml(unit)}</span>` : ''}
                </div>
                <div class="cdap-widget-body">
                    ${inner}
                </div>
            </div>
        `;
    }

    function getWidgetSizeClass(type, widget) {
        if (widget.size === 'large') return 'cdap-widget-lg';
        if (widget.size === 'small') return 'cdap-widget-sm';
        // Default sizes by type
        switch (type) {
            case 'chart': return 'cdap-widget-lg';
            case 'text': return 'cdap-widget-sm';
            case 'led': return 'cdap-widget-sm';
            default: return '';
        }
    }

    // ── Individual Widget Renderers ──────────────────────────────────────

    function renderToggle(widget) {
        const disabled = widget.read_only ? 'disabled' : '';
        return `
            <label class="cdap-toggle">
                <input type="checkbox" class="cdap-toggle-input" data-action="set" ${disabled}>
                <span class="cdap-toggle-slider"></span>
            </label>
            <span class="cdap-toggle-label" id="wval-${escapeHtml(widget.id)}">—</span>
        `;
    }

    function renderGauge(widget) {
        const min = widget.min ?? 0;
        const max = widget.max ?? 100;
        return `
            <div class="cdap-gauge">
                <div class="cdap-gauge-bar">
                    <div class="cdap-gauge-fill" id="wbar-${escapeHtml(widget.id)}" style="width: 0%"></div>
                </div>
                <div class="cdap-gauge-value">
                    <span class="cdap-gauge-number" id="wval-${escapeHtml(widget.id)}">—</span>
                    <span class="cdap-gauge-range">${min} – ${max}</span>
                </div>
            </div>
        `;
    }

    function renderButton(widget) {
        const icon = widget.icon || 'play_arrow';
        const confirmText = widget.confirm ? `data-confirm="${escapeHtml(widget.confirm)}"` : '';
        return `
            <button class="btn cdap-action-btn" data-action="trigger" ${confirmText}>
                <span class="material-icons">${escapeHtml(icon)}</span>
                <span>${escapeHtml(widget.label || widget.id)}</span>
            </button>
        `;
    }

    function renderLed(widget) {
        return `
            <div class="cdap-led" id="wled-${escapeHtml(widget.id)}">
                <div class="cdap-led-light off"></div>
                <span class="cdap-led-label" id="wval-${escapeHtml(widget.id)}">—</span>
            </div>
        `;
    }

    function renderText(widget) {
        return `
            <div class="cdap-text-value" id="wval-${escapeHtml(widget.id)}">—</div>
        `;
    }

    function renderSlider(widget) {
        const min = widget.min ?? 0;
        const max = widget.max ?? 100;
        const step = widget.step ?? 1;
        const disabled = widget.read_only ? 'disabled' : '';
        return `
            <div class="cdap-slider-wrap">
                <input type="range" class="cdap-slider-input" 
                    min="${min}" max="${max}" step="${step}" value="${min}"
                    data-action="set" ${disabled}>
                <div class="cdap-slider-labels">
                    <span>${min}</span>
                    <span class="cdap-slider-value" id="wval-${escapeHtml(widget.id)}">${min}</span>
                    <span>${max}</span>
                </div>
            </div>
        `;
    }

    function renderSelect(widget) {
        const options = widget.options || [];
        const disabled = widget.read_only ? 'disabled' : '';
        let optHtml = `<option value="">— ${t('cdap.select_option')} —</option>`;
        for (const opt of options) {
            const val = typeof opt === 'object' ? opt.value : opt;
            const label = typeof opt === 'object' ? (opt.label || opt.value) : opt;
            optHtml += `<option value="${escapeHtml(String(val))}">${escapeHtml(String(label))}</option>`;
        }
        return `
            <select class="form-input cdap-select-input" data-action="set" ${disabled}>
                ${optHtml}
            </select>
        `;
    }

    function renderChart(widget) {
        // Phase 2: simple bar-style multi-value chart
        const series = widget.series || [];
        let barsHtml = '';
        for (const s of series) {
            barsHtml += `
                <div class="cdap-chart-bar-wrap" data-series="${escapeHtml(s.key || s.label || '')}">
                    <div class="cdap-chart-bar-label">${escapeHtml(s.label || s.key || '')}</div>
                    <div class="cdap-chart-bar-track">
                        <div class="cdap-chart-bar-fill" id="wbar-${escapeHtml(widget.id)}-${escapeHtml(s.key || '')}" style="width: 0%"></div>
                    </div>
                    <div class="cdap-chart-bar-value" id="wval-${escapeHtml(widget.id)}-${escapeHtml(s.key || '')}">—</div>
                </div>
            `;
        }
        return `<div class="cdap-chart-bars">${barsHtml}</div>`;
    }

    // ── State Polling & Application ──────────────────────────────────────

    function startStatePolling() {
        if (statePollTimer) clearInterval(statePollTimer);
        statePollTimer = setInterval(pollState, STATE_POLL_INTERVAL);
    }

    async function pollState() {
        try {
            const res = await fetch(`/api/cdap/devices/${encodeURIComponent(deviceId)}/state`, {
                headers: { 'X-CSRF-Token': window.BetterDesk?.csrfToken || '' }
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.success && data.data) {
                widgetState = data.data;
                applyState(widgetState);
            }
        } catch (err) {
            // Silent fail — device may be offline
        }
    }

    function applyState(state) {
        if (!state || !manifest?.widgets) return;

        for (const widget of manifest.widgets) {
            const val = state[widget.id];
            if (val === undefined) continue;

            const el = document.querySelector(`[data-widget-id="${CSS.escape(widget.id)}"]`);
            if (!el) continue;

            switch (widget.type) {
                case 'toggle':
                    applyToggleState(el, widget, val);
                    break;
                case 'gauge':
                    applyGaugeState(el, widget, val);
                    break;
                case 'led':
                    applyLedState(el, widget, val);
                    break;
                case 'text':
                    applyTextState(el, widget, val);
                    break;
                case 'slider':
                    applySliderState(el, widget, val);
                    break;
                case 'select':
                    applySelectState(el, widget, val);
                    break;
                case 'chart':
                    applyChartState(el, widget, val);
                    break;
            }
        }
    }

    function applyToggleState(el, widget, val) {
        const input = el.querySelector('.cdap-toggle-input');
        const label = document.getElementById(`wval-${widget.id}`);
        const checked = val === true || val === 1 || val === 'on' || val === 'true';
        if (input && !input._userInteracting) input.checked = checked;
        if (label) label.textContent = checked ? 'ON' : 'OFF';
    }

    function applyGaugeState(el, widget, val) {
        const num = parseFloat(val);
        if (isNaN(num)) return;
        const min = widget.min ?? 0;
        const max = widget.max ?? 100;
        const pct = Math.min(100, Math.max(0, ((num - min) / (max - min)) * 100));

        const bar = document.getElementById(`wbar-${widget.id}`);
        const valEl = document.getElementById(`wval-${widget.id}`);
        if (bar) {
            bar.style.width = pct + '%';
            // Color based on thresholds
            if (pct > 90) bar.className = 'cdap-gauge-fill cdap-gauge-danger';
            else if (pct > 70) bar.className = 'cdap-gauge-fill cdap-gauge-warning';
            else bar.className = 'cdap-gauge-fill';
        }
        if (valEl) valEl.textContent = num.toFixed(widget.decimals ?? 1);
    }

    function applyLedState(el, widget, val) {
        const light = el.querySelector('.cdap-led-light');
        const label = document.getElementById(`wval-${widget.id}`);
        const on = val === true || val === 1 || val === 'on' || val === 'true';
        if (light) {
            light.className = `cdap-led-light ${on ? 'on' : 'off'}`;
            if (typeof val === 'string' && val.startsWith('#')) {
                light.style.backgroundColor = val;
                light.className = 'cdap-led-light on';
            }
        }
        if (label) label.textContent = typeof val === 'string' ? val : (on ? 'ON' : 'OFF');
    }

    function applyTextState(el, widget, val) {
        const valEl = document.getElementById(`wval-${widget.id}`);
        if (valEl) valEl.textContent = String(val);
    }

    function applySliderState(el, widget, val) {
        const input = el.querySelector('.cdap-slider-input');
        const valEl = document.getElementById(`wval-${widget.id}`);
        const num = parseFloat(val);
        if (isNaN(num)) return;
        if (input && !input._userInteracting) input.value = num;
        if (valEl) valEl.textContent = num.toFixed(widget.decimals ?? 0);
    }

    function applySelectState(el, widget, val) {
        const select = el.querySelector('.cdap-select-input');
        if (select && !select._userInteracting) select.value = String(val);
    }

    function applyChartState(el, widget, val) {
        if (typeof val !== 'object') return;
        const series = widget.series || [];
        for (const s of series) {
            const key = s.key || s.label || '';
            const seriesVal = val[key];
            if (seriesVal === undefined) continue;
            const num = parseFloat(seriesVal);
            if (isNaN(num)) continue;
            const min = s.min ?? 0;
            const max = s.max ?? 100;
            const pct = Math.min(100, Math.max(0, ((num - min) / (max - min)) * 100));
            const bar = document.getElementById(`wbar-${widget.id}-${key}`);
            const valEl = document.getElementById(`wval-${widget.id}-${key}`);
            if (bar) bar.style.width = pct + '%';
            if (valEl) valEl.textContent = num.toFixed(1);
        }
    }

    // ── Event Binding ────────────────────────────────────────────────────

    function bindWidgetEvents() {
        // Toggle switches
        document.querySelectorAll('.cdap-toggle-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const widgetEl = e.target.closest('.cdap-widget');
                if (!widgetEl) return;
                const wid = widgetEl.dataset.widgetId;
                window.CDAPCommands?.send(deviceId, wid, 'set', e.target.checked);
            });
            // Prevent state polling from overriding user interaction
            input.addEventListener('mousedown', () => { input._userInteracting = true; });
            input.addEventListener('change', () => { setTimeout(() => { input._userInteracting = false; }, 2000); });
        });

        // Action buttons
        document.querySelectorAll('.cdap-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const widgetEl = e.target.closest('.cdap-widget');
                if (!widgetEl) return;
                const wid = widgetEl.dataset.widgetId;
                const confirm = btn.dataset.confirm;
                if (confirm) {
                    window.CDAPCommands?.sendWithConfirm(deviceId, wid, 'trigger', null, confirm);
                } else {
                    window.CDAPCommands?.send(deviceId, wid, 'trigger', null);
                }
            });
        });

        // Sliders (debounced)
        document.querySelectorAll('.cdap-slider-input').forEach(input => {
            let debounce = null;
            input.addEventListener('input', (e) => {
                const widgetEl = e.target.closest('.cdap-widget');
                if (!widgetEl) return;
                const wid = widgetEl.dataset.widgetId;
                const valEl = document.getElementById(`wval-${wid}`);
                if (valEl) valEl.textContent = e.target.value;
                input._userInteracting = true;
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    window.CDAPCommands?.send(deviceId, wid, 'set', parseFloat(e.target.value));
                    setTimeout(() => { input._userInteracting = false; }, 2000);
                }, 300);
            });
        });

        // Selects
        document.querySelectorAll('.cdap-select-input').forEach(select => {
            select.addEventListener('change', (e) => {
                const widgetEl = e.target.closest('.cdap-widget');
                if (!widgetEl) return;
                const wid = widgetEl.dataset.widgetId;
                select._userInteracting = true;
                window.CDAPCommands?.send(deviceId, wid, 'set', e.target.value);
                setTimeout(() => { select._userInteracting = false; }, 2000);
            });
        });
    }

    // ── Utilities ────────────────────────────────────────────────────────

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatDuration(ms) {
        if (ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);
        if (d > 0) return `${d}d ${h % 24}h`;
        if (h > 0) return `${h}h ${m % 60}m`;
        if (m > 0) return `${m}m`;
        return `${s}s`;
    }

    // ── Public API ───────────────────────────────────────────────────────

    window.CDAPWidgets = {
        init,
        refresh: loadManifestAndState,
        getState: () => widgetState,
        getManifest: () => manifest,
        isDeviceConnected: () => isConnected
    };

    // Auto-init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (statePollTimer) clearInterval(statePollTimer);
        if (infoPollTimer) clearInterval(infoPollTimer);
    });
})();
