// Metrics — draws keys as 144×144 SVG.
// Uses only what SVG Tiny supports (gradients, opacity, text), no filters.
'use strict';

// Design: "Metrics Key" library in Figma. Inter first, Segoe UI when Inter is not installed.
const FONT = "Inter, 'Segoe UI Variable Display', 'Segoe UI', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- colors ----------
function hexToRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return [255, 255, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (c) => '#' + c.map(x => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((x, i) => x + (B[i] - x) * t)); };

// Reading color: calm → warm (yellow, then amber) → load (red).
function levelColor(pct, s) {
    if (pct == null) return '#5a5a5a';
    if (pct < s.warn) return s.calm;
    if (pct < s.crit) return mix(s.warm, s.hot, ((pct - s.warn) / Math.max(1, s.crit - s.warn)) * 0.6);
    return s.hot;
}

// ---------- icons: 24×24 paths from the "Metrics Key" Figma library (Metrics/Icon) ----------
const ICON_COLORS = { cpu: '#ff9f1a', ram: '#4ea1ff', gpu: '#a77bff', vram: '#3ddc5a', disk: '#ffc61a',
    net: '#2ec8e6', battery: '#9be03a', fps: '#ff5c8a' };
// variant: disk letter; NET 'down' | 'up' | 'both' (the other arrow is dimmed); BATTERY 'charging'
function icon(kind, color, letter) {
    const st = `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    switch (kind) {
        case 'cpu':
            return `<path d="M16.375 5.75C17.4105 5.75 18.25 6.58947 18.25 7.625V16.375C18.25 17.4105 17.4105 18.25 16.375 18.25H7.625C6.58947 18.25 5.75 17.4105 5.75 16.375V7.625C5.75 6.58947 6.58947 5.75 7.625 5.75H16.375ZM9.5 14.5H14.5V9.5H9.5V14.5Z" fill-rule="evenodd" fill="${color}"/>` +
                `<path d="M8.875 5.75V2M8.875 18.25V22M5.75 8.875H2M18.25 8.875H22M15.125 5.75V2M15.125 18.25V22M5.75 15.125H2M18.25 15.125H22" ${st}/>`;
        case 'ram':
            return `<path d="M3.25 6H20.75C21.4404 6 22 6.57563 22 7.28571V13.7143C22 14.4244 21.4404 15 20.75 15H3.25C2.55964 15 2 14.4244 2 13.7143V7.28571C2 6.57563 2.55964 6 3.25 6Z" ${st}/>` +
                `<path d="M6 9V12M10 9V12M14 9V12M18 9V12M4.5 15.125V18.25M8.25 15.125V18.25M12 15.125V18.25M15.75 15.125V18.25M19.5 15.125V18.25" ${st}/>`;
        case 'gpu':
            return `<path d="M3.0625 5H20.9375C22.0766 5 23 5.9402 23 7.1V16.9C23 18.0598 22.0766 19 20.9375 19H3.0625C1.92341 19 1 18.0598 1 16.9V7.1C1 5.9402 1.92341 5 3.0625 5Z" ${st}/>` +
                `<circle cx="8" cy="12" r="3" ${st}/><path d="M15 10H18.75M15 13.75H18.75" ${st}/>`;
        case 'vram':
            return `<path d="M6.375 3.25H17.625C18.6605 3.25 19.5 4.08947 19.5 5.125V18.875C19.5 19.9105 18.6605 20.75 17.625 20.75H6.375C5.33947 20.75 4.5 19.9105 4.5 18.875V5.125C4.5 4.08947 5.33947 3.25 6.375 3.25Z" ${st}/>` +
                `<path d="M8.25 7.625H15.75M8.25 12H15.75M8.25 16.375H13.25" ${st}/>`;
        case 'disk':
            if (letter) return `<text x="12" y="19.2" font-family="${FONT}" font-size="20.5" font-weight="700" fill="${color}" text-anchor="middle">${esc(letter)}</text>`;
            return `<ellipse cx="12" cy="6.375" rx="8.75" ry="3.25" ${st}/>` +
                `<path d="M3.25 6.375V17.625C3.25 19.5 7.125 20.875 12 20.875C16.875 20.875 20.75 19.5 20.75 17.625V6.375" ${st}/>` +
                `<path d="M3.25 12C3.25 13.875 7.125 15.25 12 15.25C16.875 15.25 20.75 13.875 20.75 12" ${st}/>`;
        case 'net': {
            const dn = letter === 'up' ? ' opacity="0.35"' : '', up = letter === 'down' ? ' opacity="0.35"' : '';
            return `<path d="M8 3.5V20.5M3.5 16L8 20.5L12.5 16" ${st}${dn}/>` +
                `<path d="M16 20.5V3.5M11.5 8L16 3.5L20.5 8" ${st}${up}/>`;
        }
        case 'battery':
            return `<path d="M4.125 6.5H17.875C18.9105 6.5 19.75 7.33947 19.75 8.375V15.625C19.75 16.6605 18.9105 17.5 17.875 17.5H4.125C3.08947 17.5 2.25 16.6605 2.25 15.625V8.375C2.25 7.33947 3.08947 6.5 4.125 6.5Z" ${st}/>` +
                `<path d="M22.5 10V14" ${st}/>` +
                (letter === 'charging'
                    ? `<path d="M12 8.75L8.75 12.5H13.25L10 15.25" ${st} stroke-width="1.75"/>`
                    : `<path d="M5.5 9.75H13.5V14.25H5.5Z" fill="${color}"/>`);
        case 'fps':
            return `<path d="M4.4 18.5A9.25 9.25 0 1 1 19.6 18.5" ${st}/>` +
                `<path d="M12 14L16.5 8.5" ${st}/><circle cx="12" cy="14" r="2" fill="${color}"/>` +
                `<path d="M5.5 11.5H7M12 5.75V7.25M18.5 11.5H17" ${st}/>`;
    }
    return '';
}

// Gradient ids carry the color, so several keys on one page never borrow each other's gradient.
const idOf = (c) => String(c).replace(/[^0-9a-z]/gi, '');

// ---------- key frame ----------
function frame(inner, glow, defs = '') {
    let g = '';
    if (glow) {
        g = `<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#glow${idOf(glow)})"/>` +
            `<rect x="2.5" y="2.5" width="139" height="139" rx="20" fill="none" stroke="${glow}" stroke-width="4" stroke-opacity="0.95"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
        `<defs>` +
        `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="0.55" stop-color="#0a0a0a"/><stop offset="0.75" stop-color="#1b1b1b"/><stop offset="1" stop-color="#050505"/></linearGradient>` +
        (glow ? `<radialGradient id="glow${idOf(glow)}" cx="0.5" cy="1" r="0.9"><stop offset="0" stop-color="${glow}" stop-opacity="0.45"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>` : '') +
        defs + `</defs>` +
        `<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#sheen)"/>` + g +
        `<rect x="1" y="1" width="142" height="142" rx="21" fill="none" stroke="#2c2c2c" stroke-width="2"/>` +
        inner + `</svg>`;
}

// Header: 24×24 icon, 6px gap, label in Inter Bold 16, centered as one group. Icon box y 14–38, label baseline y=32.
function header(kind, label, iconColor, letter, y = 32) {
    const lw = label.length * 11.2;          // approximate width of Inter Bold 16, uppercase
    const x0 = 72 - (24 + 6 + lw) / 2;
    return `<g transform="translate(${x0.toFixed(1)} ${y - 18})">${icon(kind, iconColor, letter)}</g>` +
        `<text x="${(x0 + 30).toFixed(1)}" y="${y}" font-family="${FONT}" font-size="16" font-weight="700" fill="#ffffff" letter-spacing="0.6">${esc(label)}</text>`;
}

const big = (text, color, size, y) =>
    `<text x="72" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="400" fill="${color}" text-anchor="middle" letter-spacing="-1">${esc(text)}</text>`;
const unitText = (text, y, color = '#9b9b9b') =>
    `<text x="72" y="${y}" font-family="${FONT}" font-size="18" font-weight="500" fill="${color}" text-anchor="middle">${esc(text)}</text>`;

// Small arrow for the NET rows, 10 wide, drawn so its bottom sits on the text baseline.
function arrow(dir, x, y, color, h) {
    const st = `fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"`;
    const top = y - h, mid = x + 5;
    return dir === 'down'
        ? `<path d="M${mid} ${top}V${y}M${x} ${y - 5}L${mid} ${y}L${x + 10} ${y - 5}" ${st}/>`
        : `<path d="M${mid} ${y}V${top}M${x} ${top + 5}L${mid} ${top}L${x + 10} ${top + 5}" ${st}/>`;
}

// One NET row: arrow on the left, value right-aligned to column vx, unit after it,
// so both rows line up whatever font the device falls back to.
function row(rw, y, size, unitSize, color, weight, vx, ax = 18) {
    return arrow(rw.dir, ax, y, color, Math.round(size * 0.72)) +
        `<text x="${vx}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="#ffffff" text-anchor="end" letter-spacing="-0.5">${esc(rw.value)}</text>` +
        `<text x="${vx + 5}" y="${y}" font-family="${FONT}" font-size="${unitSize}" font-weight="500" fill="#9b9b9b">${esc(rw.unit)}</text>`;
}

function bar(frac, color, y = 118, h = 8) {
    const x = 26, w = 92;
    const fw = frac == null ? 0 : Math.max(h, w * clamp(frac, 0, 1));
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#262626"/>` +
        (frac == null ? '' : `<rect x="${x}" y="${y}" width="${fw.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>`);
}

function graph(history, color, top = 82, bottom = 128, second = null) {
    const x0 = 14, x1 = 130, n = 15;
    const pts = history.slice(-n);
    const base = `<path d="M${x0} ${bottom}H${x1}" stroke="#2a2a2a" stroke-width="1.5"/>`;
    if (pts.length < 2) return { defs: '', body: base };
    // second series (NET upload): a thin white line over the main area
    let extra = '';
    if (second && second.length >= 2) {
        const p2 = second.slice(-n), st2 = (x1 - x0) / (n - 1), off2 = n - p2.length;
        extra = `<path d="${p2.map((v, i) => (i ? 'L' : 'M') + (x0 + (i + off2) * st2).toFixed(1) + ' ' + (bottom - (bottom - top) * clamp((v ?? 0) / 100, 0, 1)).toFixed(1)).join('')}" fill="none" stroke="#ffffff" stroke-opacity="0.75" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    const step = (x1 - x0) / (n - 1);
    const off = n - pts.length;
    const xy = pts.map((v, i) => [x0 + (i + off) * step, bottom - (bottom - top) * clamp((v ?? 0) / 100, 0, 1)]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    const area = line + `L${xy[xy.length - 1][0].toFixed(1)} ${bottom}L${xy[0][0].toFixed(1)} ${bottom}Z`;
    return {
        defs: `<linearGradient id="ga${idOf(color)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.5"/><stop offset="1" stop-color="${color}" stop-opacity="0.03"/></linearGradient>`,
        body: base + `<path d="${area}" fill="url(#ga${idOf(color)})"/>` +
            `<path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` + extra,
    };
}

// ---------- main function ----------
// r = { kind, label, letter, variant, value, unit, pct, colorPct, history:[pct...],
//       rows:[{dir,value,unit,pct}] (NET both ways), history2, msg:[line1, line2], hint }
// pct fills the bar and the graph; colorPct (when set) picks the color and the glow.
// s = key settings (style, warn, crit, peg, calm, warm, hot)
function key(r, s) {
    const mono = s.style === 'mono';
    const cp = r.colorPct != null ? r.colorPct : r.pct;
    const color = mono ? '#ffffff' : levelColor(cp, s);
    const pegged = cp != null && cp >= s.peg;
    const glow = pegged && !r.msg ? color : null;
    const iconColor = mono ? '#ffffff' : ICON_COLORS[r.kind];
    const value = r.value == null ? '—' : String(r.value);
    const valueColor = r.value == null ? '#5a5a5a' : '#ffffff';
    const head = header(r.kind, r.label, iconColor, r.letter || r.variant);

    // A message instead of a reading: "RTSS / not running", "No battery"
    if (r.msg) {
        return frame(head +
            `<text x="72" y="78" font-family="${FONT}" font-size="18" font-weight="600" fill="#d6d6d6" text-anchor="middle">${esc(r.msg[0])}</text>` +
            (r.msg[1] ? `<text x="72" y="100" font-family="${FONT}" font-size="15" font-weight="500" fill="#9b9b9b" text-anchor="middle">${esc(r.msg[1])}</text>` : '') +
            (r.hint ? `<text x="72" y="126" font-family="${FONT}" font-size="12" font-weight="500" fill="#6a6a6a" text-anchor="middle">${esc(r.hint)}</text>` : ''));
    }

    // NET both ways: two rows, download on top
    if (r.rows) {
        const rc = (p) => mono ? '#ffffff' : levelColor(p, s);
        const [d, u] = r.rows;
        if (s.style === 'graph') {
            const g = graph(r.history || [], color, 90, 128, r.history2 || []);
            return frame(head + row(d, 62, 20, 13, rc(d.pct), 700, 80, 30) + row(u, 83, 20, 13, mono ? '#ffffff' : '#bdbdbd', 700, 80, 30) + g.body, glow, g.defs);
        }
        if (s.style === 'number') return frame(head + row(d, 80, 30, 14, rc(d.pct), 400, 92) + row(u, 120, 30, 14, rc(u.pct), 400, 92), glow);
        return frame(head + row(d, 72, 28, 14, rc(d.pct), 400, 90) + bar(d.pct / 100, rc(d.pct), 81, 5) +
            row(u, 113, 28, 14, rc(u.pct), 400, 90) + bar(u.pct / 100, rc(u.pct), 122, 5), glow);
    }

    switch (s.style) {
        case 'number': { // Value XL: Inter Regular 62, baseline 91; unit baseline 112
            const sz = value.length >= 4 ? 50 : 62;
            return frame(head + big(value, r.value == null ? '#5a5a5a' : color, sz, 91) + unitText(r.unit, 112), glow);
        }
        case 'graph': { // Value S: Inter Bold 32 + unit inline, baseline 76; graph y 82–128
            const g = graph(r.history || [], color);
            const u = String(r.unit).split(' ')[0];
            const vw = value === "—" ? 30 : [...value].reduce((a, ch) => a + (ch === '.' || ch === ':' ? 9 : 18), 0), uw = u.length * 11, x0 = 72 - (vw + 9 + uw) / 2;
            const v = `<text x="${x0.toFixed(1)}" y="76" font-family="${FONT}" font-size="32" font-weight="700" fill="${valueColor}" letter-spacing="-0.5">${esc(value)}</text>`;
            const un = `<text x="${(x0 + vw + 9).toFixed(1)}" y="76" font-family="${FONT}" font-size="18" font-weight="500" fill="#9b9b9b">${esc(u)}</text>`;
            return frame(head + v + un + g.body, glow, g.defs);
        }
        default: { // 'bar' and 'mono' — Value: Inter Regular 48, baseline 80; unit baseline 102; bar y 118
            const size = value.length >= 4 ? 40 : (value.length === 3 && !value.includes('.') ? 44 : 48);
            return frame(head + big(value, valueColor, size, 80) + unitText(r.unit, 102, mono ? '#bdbdbd' : '#9b9b9b') +
                bar(r.pct == null ? null : r.pct / 100, mono ? '#ffffff' : color), glow);
        }
    }
}

module.exports = { key, levelColor };
