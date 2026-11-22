// Metrics — Stream Dock plugin: CPU, RAM, GPU, VRAM and disk, live on your keys.
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
};
const DEFAULTS = {
    style: 'bar',            // bar | mono | number | graph
    warn: 30, crit: 85, peg: 97,
    calm: '#3ddc5a', warm: '#ffd21f', hot: '#ff3b30',
    unit: 'gb',              // RAM/VRAM: gb | pct
    diskView: 'busy',        // busy | full | free
    drive: '',               // '' = all drives (activity) / system drive (space)
    vramTotalGB: 0,          // 0 = automatic
    hold: '',                // '' = default for this key
};
const DEFAULT_HOLD = { cpu: 'taskmgr', ram: 'taskmgr', gpu: 'taskmgr', vram: 'taskmgr', disk: 'drive' };
const HOLD_MS = 500;

const contexts = new Map(); // context -> { action, kind, settings, lastSvg, pressTimer, held }

function normalize(s) {
    const o = Object.assign({}, DEFAULTS, s || {});
    for (const k of ['warn', 'crit', 'peg', 'vramTotalGB']) o[k] = Number(o[k]) || 0;
    if (o.crit <= o.warn) o.crit = o.warn + 1;
    return o;
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
            contexts.set(context, { action, kind, settings: normalize(payload && payload.settings), lastSvg: null });
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
    c.settings = normalize(settings);
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
    else return;
    send({ event: 'setSettings', context, payload: s });
    refreshWants();
    redraw(context);
}

function openTarget(c) {
    let t = c.settings.hold || DEFAULT_HOLD[c.kind];
    if (t === 'none') return;
    const drive = c.settings.drive;
    try {
        if (IS_MAC) {
            t = { taskmgr: 'activity', resmon: 'activity', drive: 'finder', storage: 'settings' }[t] || t;
            const cmd = {
                activity: ['-a', 'Activity Monitor'],
                finder: [drive && drive.startsWith('/') ? drive : '/'],
                settings: ['x-apple.systempreferences:com.apple.settings.Storage'],
                sysinfo: ['-a', 'System Information'],
            }[t] || ['-a', 'Activity Monitor'];
            spawn('/usr/bin/open', cmd, { detached: true, stdio: 'ignore' }).unref();
        } else if (IS_WIN) {
            // via `start`, so Windows itself handles apps that need elevation (Task Manager)
            const target = {
                taskmgr: 'taskmgr',
                resmon: 'resmon',
                drive: rootOf(drive),
                storage: 'ms-settings:storagesense',
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
    for (const c of contexts.values()) {
        if (c.kind === 'disk') sampler.wantDrives.add(c.settings.drive || '');
    }
}

function redraw(context) {
    const h = sampler.history;
    draw(context, h[h.length - 1], h, true);
}

const GB = 1024 ** 3;
const fmtGB = (bytes) => { const g = bytes / GB; return g < 10 ? g.toFixed(1) : String(Math.round(g)); };

// Works out what the key shows: value, unit, and the percent used for color and bar.
function reading(c, sample) {
    const s = c.settings;
    const r = { kind: c.kind, label: c.kind.toUpperCase(), value: null, unit: '%', pct: null, letter: null };
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
    }
    return r;
}

function draw(context, sample, history, force = false) {
    const c = contexts.get(context);
    if (!c) return;
    let svg;
    try {
        const r = reading(c, sample);
        if (c.settings.style === 'graph') r.history = (history || []).map(h => reading(c, h).pct);
        svg = render.key(r, c.settings);
    } catch (e) { log('render error', String(e && e.stack || e)); return; }
    if (!force && svg === c.lastSvg) return; // only send the image when it changed
    c.lastSvg = svg;
    send({ event: 'setImage', context, payload: { image: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'), target: 0 } });
}

module.exports = { reading }; // for tests
