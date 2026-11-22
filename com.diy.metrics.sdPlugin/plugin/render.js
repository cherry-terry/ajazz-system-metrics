// Metrics — draws keys as 144×144 SVG.
// Uses only what SVG Tiny supports (gradients, opacity, text), no filters.
'use strict';

const FONT = "'Segoe UI Variable Display', 'Segoe UI', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
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

// ---------- 16×16 icons, centered at (0,0) ----------
const ICON_COLORS = { cpu: '#ff9f1a', ram: '#4ea1ff', gpu: '#a77bff', vram: '#3ddc5a', disk: '#ffc61a' };
function icon(kind, color, letter) {
    const s = `fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"`;
    switch (kind) {
        case 'cpu':
            return `<rect x="-5" y="-5" width="10" height="10" rx="1.5" ${s}/><rect x="-2" y="-2" width="4" height="4" fill="${color}"/>` +
                [-2.5, 2.5].map(p => `<path d="M${p} -5V-8M${p} 5V8M-5 ${p}H-8M5 ${p}H8" ${s}/>`).join('');
        case 'ram':
            return `<rect x="-8" y="-4.5" width="16" height="7" rx="1" ${s}/>` +
                [-5, -1.7, 1.7, 5].map(x => `<path d="M${x} -2V0.5" ${s}/>`).join('') +
                [-6, -3, 0, 3, 6].map(x => `<path d="M${x} 2.5V5" ${s}/>`).join('');
        case 'gpu':
            return `<rect x="-8" y="-5" width="16" height="10" rx="1.5" ${s}/><circle cx="-2" cy="0" r="2.6" ${s}/>` +
                `<path d="M3 -2H6M3 1H6" ${s}/>`;
        case 'vram':
            return `<rect x="-6" y="-7" width="12" height="14" rx="1.5" ${s}/><path d="M-3 -3.5H3M-3 0H3M-3 3.5H1" ${s}/>`;
        case 'disk':
            if (letter) return `<text x="0" y="6" font-family="${FONT}" font-size="17" font-weight="600" fill="${color}" text-anchor="middle">${esc(letter)}</text>`;
            return `<ellipse cx="0" cy="-4.5" rx="7" ry="2.6" ${s}/><path d="M-7 -4.5V4.5C-7 6 -3.9 7.1 0 7.1S7 6 7 4.5V-4.5" ${s}/><path d="M-7 0C-7 1.5 -3.9 2.6 0 2.6S7 1.5 7 0" ${s}/>`;
    }
    return '';
}

// ---------- key frame ----------
function frame(inner, glow, defs = '') {
    let g = '';
    if (glow) {
        g = `<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#glow)"/>` +
            `<rect x="2.5" y="2.5" width="139" height="139" rx="20" fill="none" stroke="${glow}" stroke-width="4" stroke-opacity="0.95"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
        `<defs>` +
        `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="0.55" stop-color="#0a0a0a"/><stop offset="0.75" stop-color="#1b1b1b"/><stop offset="1" stop-color="#050505"/></linearGradient>` +
        (glow ? `<radialGradient id="glow" cx="0.5" cy="1" r="0.9"><stop offset="0" stop-color="${glow}" stop-opacity="0.45"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>` : '') +
        defs + `</defs>` +
        `<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#sheen)"/>` + g +
        `<rect x="1" y="1" width="142" height="142" rx="21" fill="none" stroke="#2c2c2c" stroke-width="2"/>` +
        inner + `</svg>`;
}

function header(kind, label, iconColor, letter, y = 33) {
    const w = label.length * 11 + 24; // approximate width of icon + text
    const x0 = 72 - w / 2;
    return `<g transform="translate(${(x0 + 8).toFixed(1)} ${y - 6})">${icon(kind, iconColor, letter)}</g>` +
        `<text x="${(x0 + 24).toFixed(1)}" y="${y}" font-family="${FONT}" font-size="17" font-weight="700" fill="#ffffff" letter-spacing="1">${esc(label)}</text>`;
}

const big = (text, color, size, y) =>
    `<text x="72" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="400" fill="${color}" text-anchor="middle" letter-spacing="-2">${esc(text)}</text>`;
const unitText = (text, y, color = '#9b9b9b') =>
    `<text x="72" y="${y}" font-family="${FONT}" font-size="20" fill="${color}" text-anchor="middle">${esc(text)}</text>`;

function bar(frac, color, y = 121) {
    const x = 26, w = 92, h = 8;
    const fw = frac == null ? 0 : Math.max(h, w * clamp(frac, 0, 1));
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#262626"/>` +
        (frac == null ? '' : `<rect x="${x}" y="${y}" width="${fw.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>`);
}

function graph(history, color, top = 82, bottom = 128) {
    const x0 = 14, x1 = 130, n = 15;
    const pts = history.slice(-n);
    const base = `<path d="M${x0} ${bottom}H${x1}" stroke="#2a2a2a" stroke-width="1.5"/>`;
    if (pts.length < 2) return { defs: '', body: base };
    const step = (x1 - x0) / (n - 1);
    const off = n - pts.length;
    const xy = pts.map((v, i) => [x0 + (i + off) * step, bottom - (bottom - top) * clamp((v ?? 0) / 100, 0, 1)]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    const area = line + `L${xy[xy.length - 1][0].toFixed(1)} ${bottom}L${xy[0][0].toFixed(1)} ${bottom}Z`;
    return {
        defs: `<linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.5"/><stop offset="1" stop-color="${color}" stop-opacity="0.03"/></linearGradient>`,
        body: base + `<path d="${area}" fill="url(#ga)"/>` +
            `<path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`,
    };
}

// ---------- main function ----------
// r = { kind, label, letter, value, unit, pct, history:[pct...] }
// s = key settings (style, warn, crit, peg, calm, warm, hot)
function key(r, s) {
    const mono = s.style === 'mono';
    const color = mono ? '#ffffff' : levelColor(r.pct, s);
    const pegged = r.pct != null && r.pct >= s.peg;
    const glow = pegged ? color : null;
    const iconColor = mono ? '#ffffff' : ICON_COLORS[r.kind];
    const value = r.value == null ? '—' : String(r.value);
    const valueColor = r.value == null ? '#5a5a5a' : '#ffffff';
    const head = header(r.kind, r.label, iconColor, r.letter);

    switch (s.style) {
        case 'number': {
            const sz = value.length >= 4 ? 52 : 66;
            return frame(head + big(value, r.value == null ? '#5a5a5a' : color, sz, 98) + unitText(r.unit, 126), glow);
        }
        case 'graph': {
            const g = graph(r.history || [], color);
            const valueW = value.length * 17;
            const v = `<text x="${(72 - 8).toFixed(1)}" y="70" font-family="${FONT}" font-size="36" fill="${valueColor}" text-anchor="middle" letter-spacing="-1">${esc(value)}</text>`;
            const u = `<text x="${(64 + valueW / 2 + 3).toFixed(1)}" y="70" font-family="${FONT}" font-size="15" fill="#9b9b9b">${esc(String(r.unit).split(' ')[0])}</text>`;
            return frame(head + v + u + g.body, glow, g.defs);
        }
        default: { // 'bar' and 'mono'
            const size = value.length >= 4 ? 46 : (value.length === 3 && !value.includes('.') ? 52 : 58);
            return frame(head + big(value, valueColor, size, 90) + unitText(r.unit, 111, mono ? '#bdbdbd' : '#9b9b9b') +
                bar(r.pct == null ? null : r.pct / 100, mono ? '#ffffff' : color), glow);
        }
    }
}

module.exports = { key, levelColor };
