// Metrics — one shared reading for every key.
// Windows: one hidden PowerShell process reads performance counters through WMI/CIM
//          (class names are not localized, so it works on any Windows language), no admin rights.
// macOS:   os.cpus, vm_stat, ioreg. Disk: space only (macOS does not expose activity without root).
'use strict';

const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const INTERVAL = 1000;

// ---------- PowerShell script (Windows) ----------
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$parent = __PARENT__
function Get-VramTotal {
  $max = 0
  Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p) { return }
    $q = $p.'HardwareInformation.qwMemorySize'
    if ($q -is [byte[]]) { $q = [BitConverter]::ToUInt64($q, 0) }
    if (-not $q) {
      $m = $p.'HardwareInformation.MemorySize'
      if ($m -is [byte[]]) { $q = [BitConverter]::ToUInt32($m, 0) } else { $q = $m }
    }
    if ($q -and [double]$q -gt $max) { $max = [double]$q }
  }
  $max
}
$vramTotal = Get-VramTotal
$n = 0
while ($true) {
  $t0 = [Environment]::TickCount
  if (($n % 5) -eq 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  $n++
  $o = @{}
  $p = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
  if ($p) { $o.cpu = [double]$p.PercentProcessorUtility; $o.cpuTime = [double]$p.PercentProcessorTime }

  $eng = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
  if ($eng) {
    $h = @{}
    foreach ($e in $eng) {
      if ($e.Name -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_(\d+)_eng_(\d+)') {
        $k = $matches[1] + '|' + $matches[2] + '|' + $matches[3]
        $h[$k] = [double]$h[$k] + [double]$e.UtilizationPercentage
      }
    }
    $mx = 0; foreach ($v in $h.Values) { if ($v -gt $mx) { $mx = $v } }
    $o.gpu = [Math]::Min(100, $mx)
  }

  $mem = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory
  if ($mem) {
    $d = 0; foreach ($m in $mem) { if ([double]$m.DedicatedUsage -gt $d) { $d = [double]$m.DedicatedUsage } }
    $o.vramUsed = $d
  }
  if ($vramTotal) { $o.vramTotal = $vramTotal }

  $dk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk
  if ($dk) {
    $list = @()
    foreach ($x in $dk) {
      if ($x.Name -ne '_Total') {
        $list += @{ n = [string]$x.Name; a = [Math]::Max(0, [Math]::Min(100, 100 - [double]$x.PercentIdleTime)) }
      }
    }
    $o.disks = $list
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  $left = 1000 - ([Environment]::TickCount - $t0)
  if ($left -gt 50) { Start-Sleep -Milliseconds $left }
}
`;

class Sampler {
    constructor(log) {
        this.log = log || (() => {});
        this.listeners = new Set();
        this.history = [];          // last 15 samples for the graph
        this.wantDrives = new Set(); // drives that need space readings
        this.ps = null;
        this.psData = null;
        this.psAt = 0;
        this.psRestarts = 0;
        this.timer = null;
        this.prevCpu = null;
        this.mac = {};
        this.running = false;
    }

    onSample(fn) { this.listeners.add(fn); }

    start() {
        if (this.running) return;
        this.running = true;
        this.prevCpu = cpuTimes();
        if (IS_WIN) this._startPs();
        if (IS_MAC) this._macTick();
        this.timer = setInterval(() => this._tick(), INTERVAL);
        this.log('sampler started');
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.timer); this.timer = null;
        if (this.ps) { try { this.ps.kill(); } catch (_) {} this.ps = null; }
        this.log('sampler stopped');
    }

    // ----- Windows: PowerShell -----
    _startPs() {
        const script = PS_SCRIPT.replace('__PARENT__', String(process.pid));
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const exe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        try {
            this.ps = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
                { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { this.log('ps spawn failed', String(e)); this.ps = null; return; }
        const rl = readline.createInterface({ input: this.ps.stdout });
        rl.on('line', (line) => {
            line = line.trim();
            if (!line.startsWith('{')) return;
            try { this.psData = JSON.parse(line); this.psAt = Date.now(); } catch (_) {}
        });
        this.ps.stderr.on('data', d => this.log('ps stderr', d.toString().slice(0, 300)));
        this.ps.on('exit', (code) => {
            this.log('ps exit', code);
            this.ps = null;
            if (this.running && this.psRestarts < 20) {
                this.psRestarts++;
                setTimeout(() => this.running && !this.ps && this._startPs(), 3000 * this.psRestarts);
            }
        });
        this.ps.on('error', e => this.log('ps error', String(e)));
    }

    // ----- macOS -----
    _macTick() {
        execFile('/usr/bin/vm_stat', { timeout: 2000 }, (err, out) => {
            if (err || !out) return;
            const page = Number((/page size of (\d+)/.exec(out) || [])[1]) || 4096;
            const get = (name) => Number((new RegExp(name + ':\\s+(\\d+)').exec(out) || [])[1]) || 0;
            // roughly Activity Monitor's "Memory Used": app + wired + compressed
            const used = (get('Anonymous pages') - get('Pages purgeable') + get('Pages wired down') + get('Pages occupied by compressor')) * page;
            const fallback = (get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')) * page;
            this.mac.ramUsed = used > 0 ? used : fallback;
        });
        execFile('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 3000, maxBuffer: 4 << 20 }, (err, out) => {
            if (err || !out) return;
            const util = [...out.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map(m => Number(m[1]));
            const inUse = [...out.matchAll(/"In use system memory"\s*=\s*(\d+)/g)].map(m => Number(m[1]));
            if (util.length) this.mac.gpu = Math.max(...util);
            if (inUse.length) this.mac.gpuMem = Math.max(...inUse);
        });
    }

    // ----- shared tick -----
    _tick() {
        if (IS_MAC) this._macTick();
        const now = Date.now();
        const ps = (this.psData && now - this.psAt < 4000) ? this.psData : null;

        // CPU: Task Manager counter (Processor Utility), otherwise os.cpus()
        const cur = cpuTimes();
        let cpuOs = null;
        if (this.prevCpu) {
            const dt = cur.total - this.prevCpu.total, di = cur.idle - this.prevCpu.idle;
            if (dt > 0) cpuOs = clamp(100 * (1 - di / dt), 0, 100);
        }
        this.prevCpu = cur;
        let cpu = cpuOs;
        if (ps && typeof ps.cpu === 'number') cpu = clamp(ps.cpu, 0, 100);

        // RAM
        const ramTotal = os.totalmem();
        let ramUsed = ramTotal - os.freemem(); // on Windows freemem = available memory
        if (IS_MAC && this.mac.ramUsed) ramUsed = this.mac.ramUsed;

        // GPU and video memory
        let gpu = null, vramUsed = null, vramTotal = null;
        if (ps) {
            if (typeof ps.gpu === 'number') gpu = clamp(ps.gpu, 0, 100);
            if (typeof ps.vramUsed === 'number') vramUsed = ps.vramUsed;
            if (typeof ps.vramTotal === 'number' && ps.vramTotal > 0) vramTotal = ps.vramTotal;
        }
        if (IS_MAC) {
            if (this.mac.gpu != null) gpu = clamp(this.mac.gpu, 0, 100);
            if (this.mac.gpuMem != null) { vramUsed = this.mac.gpuMem; vramTotal = ramTotal; }
        }

        // Disks: activity per physical disk, space for the volumes in use
        const disks = ps && Array.isArray(ps.disks) ? ps.disks : (ps && ps.disks ? [ps.disks] : null);
        const space = {};
        for (const d of this.wantDrives) space[d] = diskSpace(d);

        const sample = { t: now, cpu, ramUsed, ramTotal, gpu, vramUsed, vramTotal, disks, space, live: IS_WIN ? !!ps : true };
        this.history.push(sample);
        if (this.history.length > 15) this.history.shift();
        for (const fn of this.listeners) { try { fn(sample, this.history); } catch (e) { this.log('listener', String(e && e.stack || e)); } }
    }
}

// ---------- helpers ----------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function cpuTimes() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
        const t = c.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
}

function rootOf(drive) {
    if (IS_WIN) return (drive || process.env.SystemDrive || 'C:').replace(/\\?$/, '') + '\\';
    return drive || '/';
}

function diskSpace(drive) {
    try {
        const s = fs.statfsSync(rootOf(drive));
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        if (!total) return null;
        return { total, free, used: total - free };
    } catch (_) { return null; }
}

function listDrives() {
    if (!IS_WIN) return ['/'];
    const out = [];
    for (let c = 67; c <= 90; c++) { // C..Z
        const d = String.fromCharCode(c) + ':';
        try { if (fs.statfsSync(d + '\\').blocks > 0) out.push(d); } catch (_) {}
    }
    return out;
}

module.exports = { Sampler, listDrives, rootOf, IS_WIN, IS_MAC };
