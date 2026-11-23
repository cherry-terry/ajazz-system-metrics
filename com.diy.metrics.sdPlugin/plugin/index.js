// Metrics — Stream Dock plugin: CPU, RAM, GPU, VRAM, disk, network, battery and FPS, live on your keys.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const render = require('./render');
const { Sampler, listDrives, rootOf, IS_WIN, IS_MAC } = require('./sampler');

// ---------- log ----------
const logDir = path.join(__dirname, 'log');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
const logFile = path.join(logDir, 'plugin.log');
try { if (fs.statSync(logFile).size > 512 * 1024) fs.unlinkSync(logFile); } catch (_) {}
function log(...a) {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`); } catch (_) {}
}
process.on('uncaughtException', e => log('uncaught', String(e && e.stack || e)));
process.on('unhandledRejection', e => log('unhandled', String(e && e.stack || e)));

// ---------- arguments from Stream Dock ----------
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = arg('-port') || process.argv[3];
const pluginUUID = arg('-pluginUUID') || process.argv[5];
const registerEvent = arg('-registerEvent') || process.argv[7];

// ---------- actions ----------
const KINDS = {
    'com.diy.metrics.cpu': 'cpu',
    'com.diy.metrics.ram': 'ram',
    'com.diy.metrics.gpu': 'gpu',
    'com.diy.metrics.vram': 'vram',
    'com.diy.metrics.disk': 'disk',
    'com.diy.metrics.net': 'net',
    'com.diy.metrics.battery': 'battery',
    'com.diy.metrics.fps': 'fps',
};
const HELP_URL = 'https://github.com/cherry-terry/ajazz-system-metrics#-fps';
const DEFAULTS = {
    style: 'bar',            // bar | mono | number | graph
    warn: 30, crit: 85, peg: 97,
    calm: '#3ddc5a', warm: '#ffd21f', hot: '#ff3b30',
    unit: 'gb',              // RAM/VRAM: gb | pct
    diskView: 'busy',        // busy | full | free
    drive: '',               // '' = all drives (activity) / system drive (space)
    vramTotalGB: 0,          // 0 = automatic
    hold: '',                // '' = default for this key
    netView: 'down',         // NET: down | up | both
    netUnit: 'bytes',        // NET: bytes (MB/s) | bits (Mb/s)
    netMax: 500,             // NET: full bar at this speed, Mbit/s
    batView: 'pct',          // BATTERY: pct | time
    fpsView: 'fps',          // FPS: fps | ms
    fpsMax: 144,             // FPS: full bar at this frame rate
};
// Battery and FPS are bad when LOW, so their thresholds count downwards.
const KIND_DEFAULTS = {
    battery: { warn: 50, crit: 20, peg: 5 },  // calm above 50 %, red below 20 %, glow below 5 %
    fps: { warn: 60, crit: 30, peg: 0 },      // calm from 60 fps, red below 30, no glow
    net: { warn: 50, crit: 90, peg: 101 },    // busy traffic is not an alarm: no glow by default
};
const INVERTED = new Set(['battery', 'fps']);
const DEFAULT_HOLD = { cpu: 'taskmgr', ram: 'taskmgr', gpu: 'taskmgr', vram: 'taskmgr', disk: 'drive', net: 'resmon', battery: 'power', fps: 'help' };
const HOLD_MS = 500;

const contexts = new Map(); // context -> { action, kind, settings, lastSvg, pressTimer, held }

function normalize(s, kind) {
    const o = Object.assign({}, DEFAULTS, KIND_DEFAULTS[kind] || {}, s || {});
    for (const k of ['warn', 'crit', 'peg', 'vramTotalGB', 'netMax', 'fpsMax']) o[k] = Number(o[k]) || 0;
    if (o.netMax <= 0) o.netMax = DEFAULTS.netMax;
    if (o.fpsMax <= 0) o.fpsMax = DEFAULTS.fpsMax;
    if (INVERTED.has(kind)) { if (o.crit >= o.warn) o.crit = Math.max(0, o.warn - 1); }
    else if (o.crit <= o.warn) o.crit = o.warn + 1;
    return o;
}

// For keys where low is bad, render gets "100 - value" and mirrored thresholds,
// so the same calm → warm → load scale works in both directions.
function renderSettings(c) {
    const s = c.settings;
    if (!INVERTED.has(c.kind)) return s;
    return Object.assign({}, s, { warn: 100 - s.warn, crit: 100 - s.crit, peg: s.peg > 0 ? 100 - s.peg : Infinity });
}

// ---------- Stream Dock WebSocket ----------
const ws = new WebSocket('ws://127.0.0.1:' + port);
const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

ws.on('open', () => { send({ event: registerEvent, uuid: pluginUUID }); log('registered', process.platform); });
ws.on('close', () => { sampler.stop(); process.exit(0); });
ws.on('error', e => log('ws error', String(e)));
ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const { event, action, context, payload } = msg;
    const kind = KINDS[action];
    switch (event) {
        case 'willAppear':
            if (!kind) return;
            contexts.set(context, { action, kind, settings: normalize(payload && payload.settings, kind), lastSvg: null });
            refreshWants();
            sampler.start();
            draw(context, sampler.history[sampler.history.length - 1], sampler.history, true);
            break;
        case 'willDisappear':
            contexts.delete(context);
            refreshWants();
            scheduleStop();
            break;
        case 'didReceiveSettings':
            updateSettings(context, payload && payload.settings);
            break;
        case 'sendToPlugin':
            if (payload && payload.type === 'settings') updateSettings(context, payload.settings);
            if (payload && payload.type === 'hello') sendPiInfo(context, action);
            if (payload && payload.type === 'help') openUrl(HELP_URL);
            break;
        case 'propertyInspectorDidAppear':
            sendPiInfo(context, action);
            break;
        case 'keyDown': onKeyDown(context); break;
        case 'keyUp': onKeyUp(context); break;
    }
});

function updateSettings(context, settings) {
    const c = contexts.get(context);
    if (!c || !settings) return;
    c.settings = normalize(settings, c.kind);
    refreshWants();
    redraw(context);
}

function sendPiInfo(context, action) {
    send({ event: 'sendToPropertyInspector', action, context,
        payload: { type: 'info', platform: IS_MAC ? 'mac' : (IS_WIN ? 'windows' : 'other'), drives: listDrives() } });
}

let stopTimer = null;
function scheduleStop() {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { if (contexts.size === 0) sampler.stop(); }, 5000);
}

// ---------- presses: a tap flips the unit, a hold opens an app ----------
function onKeyDown(context) {
    const c = contexts.get(context);
    if (!c) return;
    c.held = false;
    clearTimeout(c.pressTimer);
    c.pressTimer = setTimeout(() => { c.held = true; openTarget(c); }, HOLD_MS);
}

function onKeyUp(context) {
    const c = contexts.get(context);
    if (!c) return;
    clearTimeout(c.pressTimer);
    if (c.held) return;
    const s = c.settings;
    if (c.kind === 'ram' || c.kind === 'vram') s.unit = s.unit === 'pct' ? 'gb' : 'pct';
    else if (c.kind === 'disk') s.diskView = { busy: 'full', full: 'free', free: IS_MAC ? 'full' : 'busy' }[s.diskView] || 'busy';
    else if (c.kind === 'net') s.netView = { down: 'up', up: 'both', both: 'down' }[s.netView] || 'down';
    else if (c.kind === 'battery') s.batView = s.batView === 'time' ? 'pct' : 'time';
    else if (c.kind === 'fps') { if (!rtssOn()) return; s.fpsView = s.fpsView === 'ms' ? 'fps' : 'ms'; }
    else return;
    send({ event: 'setSettings', context, payload: s });
    refreshWants();
    redraw(context);
}

function rtssOn() {
    const h = sampler.history, f = h.length ? h[h.length - 1].fps : null;
    return !!(f && f.on);
}

function openUrl(url) {
    try {
        if (IS_MAC) spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }).unref();
        else if (IS_WIN) spawn('cmd.exe', ['/d', '/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
        log('open', url);
    } catch (e) { log('open failed', String(e)); }
}

function openTarget(c) {
    let t = c.settings.hold || DEFAULT_HOLD[c.kind];
    // FPS without RivaTuner: a hold always explains how to set it up
    if (c.kind === 'fps' && !rtssOn()) t = 'help';
    if (t === 'none') return;
    if (t === 'help') return openUrl(HELP_URL);
    const drive = c.settings.drive;
    try {
        if (IS_MAC) {
            t = { taskmgr: 'activity', resmon: 'activity', drive: 'finder', storage: 'settings' }[t] || t;
            const cmd = {
                activity: ['-a', 'Activity Monitor'],
                finder: [drive && drive.startsWith('/') ? drive : '/'],
                settings: ['x-apple.systempreferences:com.apple.settings.Storage'],
                sysinfo: ['-a', 'System Information'],
                network: ['x-apple.systempreferences:com.apple.Network-Settings.extension'],
                power: ['x-apple.systempreferences:com.apple.Battery-Settings.extension'],
            }[t] || ['-a', 'Activity Monitor'];
            spawn('/usr/bin/open', cmd, { detached: true, stdio: 'ignore' }).unref();
        } else if (IS_WIN) {
            // via `start`, so Windows itself handles apps that need elevation (Task Manager)
            const target = {
                taskmgr: 'taskmgr',
                resmon: 'resmon',
                drive: rootOf(drive),
                storage: 'ms-settings:storagesense',
                network: 'ms-settings:network-status',
                power: 'ms-settings:batterysaver',
            }[t] || 'taskmgr';
            spawn('cmd.exe', ['/d', '/c', `start "" "${target}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
        }
        log('open', t);
    } catch (e) { log('open failed', String(e)); }
}

// ---------- sampling and drawing ----------
const sampler = new Sampler(log);
sampler.onSample((sample, history) => { for (const ctx of contexts.keys()) draw(ctx, sample, history); });

function refreshWants() {
    sampler.wantDrives.clear();
    sampler.want.net = false; sampler.want.battery = false;
    for (const c of contexts.values()) {
        if (c.kind === 'disk') sampler.wantDrives.add(c.settings.drive || '');
        if (c.kind === 'net') sampler.want.net = true;
        if (c.kind === 'battery') sampler.want.battery = true;
    }
}

function redraw(context) {
    const h = sampler.history;
    draw(context, h[h.length - 1], h, true);
}

const GB = 1024 ** 3;
const fmtGB = (bytes) => { const g = bytes / GB; return g < 10 ? g.toFixed(1) : String(Math.round(g)); };

// Network speed with at most 4 characters: 0.4 KB/s, 85.2 KB/s, 112 MB/s, 1.1 GB/s (or Kb/s, Mb/s, Gb/s).
function fmtRate(bytesPerSec, bits) {
    let v = bytesPerSec * (bits ? 8 : 1) / 1000;
    const units = bits ? ['Kb/s', 'Mb/s', 'Gb/s'] : ['KB/s', 'MB/s', 'GB/s'];
    let i = 0;
    while (v >= 999.5 && i < units.length - 1) { v /= 1000; i++; }
    return { value: v < 99.95 ? v.toFixed(1) : String(Math.round(v)), unit: units[i] };
}
const fmtTime = (mins) => `${Math.floor(mins / 60)}:${String(Math.round(mins % 60)).padStart(2, '0')}`;

// Works out what the key shows: value, unit, and the percent used for color and bar.
function reading(c, sample) {
    const s = c.settings;
    const r = { kind: c.kind, label: c.kind.toUpperCase(), value: null, unit: { net: 'MB/s', fps: 'fps' }[c.kind] || '%', pct: null, letter: null };
    if (!sample) return r;
    switch (c.kind) {
        case 'cpu':
        case 'gpu': {
            const v = sample[c.kind];
            if (v != null) { r.pct = v; r.value = String(Math.round(v)); }
            break;
        }
        case 'ram':
        case 'vram': {
            const used = c.kind === 'ram' ? sample.ramUsed : sample.vramUsed;
            let total = c.kind === 'ram' ? sample.ramTotal : sample.vramTotal;
            if (c.kind === 'vram') {
                if (IS_MAC) r.label = 'GPU MEM';
                if (s.vramTotalGB > 0) total = s.vramTotalGB * GB;
            }
            if (used == null) break;
            if (total) r.pct = Math.max(0, Math.min(100, 100 * used / total));
            if (s.unit === 'pct' && r.pct != null) { r.value = String(Math.round(r.pct)); r.unit = '%'; }
            else { r.value = fmtGB(used); r.unit = 'GB'; }
            break;
        }
        case 'disk': {
            const drive = s.drive || '';
            if (IS_WIN) r.letter = drive ? drive.charAt(0) : null;
            let view = s.diskView;
            if (view === 'busy' && !IS_WIN) view = 'full';
            if (view === 'busy') {
                const list = sample.disks;
                if (!list) break;
                let a = null;
                for (const d of list) {
                    if (drive && !String(d.n).toUpperCase().includes(drive.toUpperCase())) continue;
                    a = a == null ? d.a : Math.max(a, d.a);
                }
                if (a != null) { r.pct = a; r.value = String(Math.round(a)); r.unit = '% busy'; }
            } else {
                const sp = sample.space && sample.space[drive];
                if (!sp) break;
                r.pct = 100 * sp.used / sp.total;
                if (view === 'free') { r.value = fmtGB(sp.free); r.unit = 'GB free'; }
                else { r.value = String(Math.round(r.pct)); r.unit = '% full'; }
            }
            break;
        }
        case 'net': {
            const n = sample.net;
            r.variant = s.netView;
            if (!n) break;
            const bits = s.netUnit === 'bits';
            const pctOf = (b) => Math.max(0, Math.min(100, 100 * b * 8 / (s.netMax * 1e6)));
            if (s.netView === 'both') {
                const d = fmtRate(n.rx, bits), u = fmtRate(n.tx, bits);
                r.rows = [{ dir: 'down', value: d.value, unit: d.unit, pct: pctOf(n.rx) }, { dir: 'up', value: u.value, unit: u.unit, pct: pctOf(n.tx) }];
                r.pct = pctOf(n.rx); r.pct2 = pctOf(n.tx);
                r.colorPct = Math.max(r.pct, r.pct2);
                r.value = d.value; r.unit = d.unit;
            } else {
                const b = s.netView === 'up' ? n.tx : n.rx;
                const f = fmtRate(b, bits);
                r.pct = pctOf(b); r.value = f.value;
                r.unit = f.unit + (s.netView === 'up' ? ' up' : ' down');
            }
            break;
        }
        case 'battery': {
            const b = sample.bat;
            if (!b) break;
            if (b.none) { r.msg = ['No battery', 'on this computer']; break; }
            r.pct = b.pct;
            r.colorPct = 100 - b.pct;
            if (b.plugged) r.variant = 'charging';
            if (s.batView === 'time' && b.mins != null) { r.value = fmtTime(b.mins); r.unit = 'left'; }
            else { r.value = String(Math.round(b.pct)); r.unit = b.charging ? '% charging' : (b.plugged ? '% plugged in' : '%'); }
            break;
        }
        case 'fps': {
            const f = sample.fps;
            if (!f) break;
            if (f.unsupported) { r.msg = ['Windows only', 'needs RivaTuner']; break; }
            if (!f.on) { r.msg = ['RTSS', 'not running']; r.hint = 'hold for help'; break; }
            if (f.fps == null) { r.unit = 'no game'; break; }
            r.pct = Math.max(0, Math.min(100, 100 * f.fps / s.fpsMax));
            r.colorPct = 100 - f.fps;
            if (s.fpsView === 'ms' && f.ms) { r.value = f.ms < 10 ? f.ms.toFixed(1) : String(Math.round(f.ms)); r.unit = 'ms'; }
            else { r.value = String(Math.round(f.fps)); r.unit = 'fps'; }
            break;
        }
    }
    return r;
}

// The key image for one context: reading plus graph history.
function compose(c, sample, history) {
    const r = reading(c, sample);
    if (c.settings.style === 'graph') {
        const past = (history || []).map(h => reading(c, h));
        r.history = past.map(p => p.pct);
        if (r.rows) r.history2 = past.map(p => p.pct2);
        if (c.kind === 'net') { // traffic graph scales to the recent peak, so small traffic is still visible
            const peak = Math.max(2, ...r.history.filter(v => v != null), ...(r.history2 || []).filter(v => v != null));
            const k = 90 / peak;
            r.history = r.history.map(v => v == null ? v : v * k);
            if (r.history2) r.history2 = r.history2.map(v => v == null ? v : v * k);
        }
    }
    return render.key(r, renderSettings(c));
}

function draw(context, sample, history, force = false) {
    const c = contexts.get(context);
    if (!c) return;
    let svg;
    try { svg = compose(c, sample, history); } catch (e) { log('render error', String(e && e.stack || e)); return; }
    if (!force && svg === c.lastSvg) return; // only send the image when it changed
    c.lastSvg = svg;
    send({ event: 'setImage', context, payload: { image: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'), target: 0 } });
}

module.exports = { reading, normalize, compose }; // for tests
