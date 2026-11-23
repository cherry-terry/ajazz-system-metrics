// Metrics — one shared reading for every key.
// Windows: one hidden PowerShell process reads performance counters through WMI/CIM
//          (class names are not localized, so it works on any Windows language), no admin rights.
//          FPS comes from RivaTuner Statistics Server shared memory, only when RTSS is running.
// macOS:   os.cpus, vm_stat, ioreg, netstat, pmset. Disk: space only (macOS does not expose activity without root).
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

# Network adapters that only mirror traffic of a real one, or carry none.
$skipNet = 'isatap|Teredo|Loopback|Pseudo|6to4|vEthernet|Hyper-V|VirtualBox|VMware|WAN Miniport|Kernel Debug'

# FPS of the foreground game from RivaTuner Statistics Server (RTSSSharedMemoryV2).
# Layout per RTSSSharedMemory.h: header dwSignature 'RTSS', dwVersion, dwAppEntrySize, dwAppArrOffset, dwAppArrSize;
# app entry: dwProcessID @0, szName[260] @4, dwFlags @264, dwTime0 @268, dwTime1 @272, dwFrames @276, dwFrameTime @280.
$fgType = 0
function Get-ForegroundPid {
  if ($script:fgType -eq 0) {
    try {
      Add-Type -Namespace MetricsFg -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'
      $script:fgType = 1
    } catch { $script:fgType = -1 }
  }
  if ($script:fgType -ne 1) { return 0 }
  $fp = [uint32]0
  [void][MetricsFg.W]::GetWindowThreadProcessId([MetricsFg.W]::GetForegroundWindow(), [ref]$fp)
  $fp
}
function Get-Fps {
  $mm = $null; $va = $null
  try { $mm = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('RTSSSharedMemoryV2', [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read) } catch { return @{ on = 0 } }
  try {
    $va = $mm.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
    if ($va.ReadUInt32(0) -ne 0x52545353 -or $va.ReadUInt32(4) -lt 0x00020000) { return @{ on = 0 } }
    $es = [double]$va.ReadUInt32(8); $ao = [double]$va.ReadUInt32(12); $an = [Math]::Min(256, [double]$va.ReadUInt32(16))
    $fpid = Get-ForegroundPid
    $now = [double][BitConverter]::ToUInt32([BitConverter]::GetBytes([Environment]::TickCount), 0)
    $best = $null; $bestAge = 1e12
    for ($i = 0; $i -lt $an; $i++) {
      $b = [long]($ao + $i * $es)
      $apid = $va.ReadUInt32($b); if (-not $apid) { continue }
      $t0 = [double]$va.ReadUInt32($b + 268); $t1 = [double]$va.ReadUInt32($b + 272)
      $fr = [double]$va.ReadUInt32($b + 276); $ft = [double]$va.ReadUInt32($b + 280)
      if ($t1 -le $t0 -or $fr -le 0) { continue }
      $age = $now - $t1; if ($age -lt 0) { $age += 4294967296 }
      if ($age -gt 3000) { continue }
      $e = @{ fps = 1000.0 * $fr / ($t1 - $t0); ms = $ft / 1000.0 }
      if ($fpid -and $apid -eq $fpid) { $best = $e; break }
      if ($age -lt $bestAge) { $best = $e; $bestAge = $age }
    }
    $r = @{ on = 1 }
    if ($best) { $r.fps = [Math]::Round($best.fps, 1); $r.ms = [Math]::Round($best.ms, 2) }
    return $r
  } catch { return @{ on = 0 } } finally { if ($va) { $va.Dispose() }; if ($mm) { $mm.Dispose() } }
}

$bat = $null; $batChecked = $false
$netPrev = $null
$diskPrev = $null
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

  # Disk activity: raw idle-time counter, turned into "% busy" here from two readings a second apart.
  # The ready-made formatted counter often reads 0 when queried this way, so it is only a fallback.
  $dr = Get-CimInstance -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk
  $list = @(); $dOk = $false
  if ($dr) {
    $cur = @{}
    foreach ($x in $dr) {
      if ($x.Name -eq '_Total') { continue }
      $nm = [string]$x.Name; $idle = [double]$x.PercentIdleTime; $ts = [double]$x.Timestamp_Sys100NS
      $cur[$nm] = @($idle, $ts)
      if ($diskPrev -and $diskPrev.ContainsKey($nm)) {
        $p0 = $diskPrev[$nm]; $dt = $ts - $p0[1]
        if ($dt -gt 0) {
          $busy = 100 - 100 * ($idle - $p0[0]) / $dt
          $list += @{ n = $nm; a = [Math]::Max(0, [Math]::Min(100, $busy)) }; $dOk = $true
        }
      }
    }
    $diskPrev = $cur
  }
  if (-not $dOk -and -not $diskPrev) {
    $dk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk
    foreach ($x in $dk) {
      if ($x.Name -ne '_Total') { $list += @{ n = [string]$x.Name; a = [Math]::Max(0, [Math]::Min(100, 100 - [double]$x.PercentIdleTime)) }; $dOk = $true }
    }
  }
  if ($dOk) { $o.disks = $list }

  # Network: byte counters of every adapter that is up, turned into bytes per second here.
  # Works the same on every Windows build; the WMI rate counter is only a fallback.
  $rx = 0; $tx = 0; $nOk = $false
  try {
    foreach ($a in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ([string]$a.OperationalStatus -ne 'Up') { continue }
      $nt = [string]$a.NetworkInterfaceType
      if ($nt -eq 'Loopback' -or $nt -eq 'Tunnel') { continue }
      if ($a.Name -match $skipNet -or $a.Description -match $skipNet) { continue }
      $st = $null
      try { $st = $a.GetIPStatistics() } catch { try { $st = $a.GetIPv4Statistics() } catch {} }
      if ($st) { $rx += [double]$st.BytesReceived; $tx += [double]$st.BytesSent; $nOk = $true }
    }
  } catch {}
  if ($nOk) {
    $tn = [Environment]::TickCount
    if ($netPrev) {
      $dt = ($tn - $netPrev.t) / 1000.0
      if ($dt -gt 0.2) { $o.net = @{ rx = [Math]::Max(0, ($rx - $netPrev.rx) / $dt); tx = [Math]::Max(0, ($tx - $netPrev.tx) / $dt) } }
    }
    $netPrev = @{ rx = $rx; tx = $tx; t = $tn }
  } else {
    $ni = Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface
    if ($ni) {
      $rx = 0; $tx = 0
      foreach ($x in $ni) { if ($x.Name -notmatch $skipNet) { $rx += [double]$x.BytesReceivedPersec; $tx += [double]$x.BytesSentPersec } }
      $o.net = @{ rx = $rx; tx = $tx }
    }
  }

  if (($n % 5) -eq 1) {
    $b = @(Get-CimInstance -ClassName Win32_Battery)
    $batChecked = $true
    if ($b.Count -gt 0 -and $b[0]) { $bat = @{ c = [double]$b[0].EstimatedChargeRemaining; s = [int]$b[0].BatteryStatus; m = [double]$b[0].EstimatedRunTime } } else { $bat = $null }
  }
  if ($bat) { $o.bat = $bat } elseif ($batChecked) { $o.bat = 0 }

  $o.fps = Get-Fps
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
        this.want = { net: false, battery: false }; // extra readings outside Windows
        this.netPrev = null;
        this.other = {};
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

    // ----- macOS and others: network and battery -----
    _netTick() {
        const done = (rx, tx) => {
            const now = Date.now();
            const p = this.netPrev;
            this.netPrev = { rx, tx, t: now };
            if (!p || now <= p.t) return;
            const dt = (now - p.t) / 1000;
            this.other.net = { rx: Math.max(0, (rx - p.rx) / dt), tx: Math.max(0, (tx - p.tx) / dt) };
        };
        if (IS_MAC) {
            execFile('/usr/sbin/netstat', ['-ibn'], { timeout: 2000, maxBuffer: 1 << 20 }, (err, out) => {
                if (err || !out) return;
                let rx = 0, tx = 0;
                for (const line of out.split('\n').slice(1)) {
                    const f = line.trim().split(/\s+/);
                    // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll; one <Link#n> row per interface
                    if (f.length < 10 || !/^<Link#/.test(f[2]) || /^(lo|gif|stf|utun|awdl|llw|bridge|anpi|ap)\d/.test(f[0])) continue;
                    const off = f.length >= 11 ? 0 : -1; // Address can be empty
                    rx += Number(f[6 + off]) || 0; tx += Number(f[9 + off]) || 0;
                }
                done(rx, tx);
            });
        } else {
            fs.readFile('/proc/net/dev', 'utf8', (err, out) => {
                if (err || !out) return;
                let rx = 0, tx = 0;
                for (const line of out.split('\n').slice(2)) {
                    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
                    if (!m || /^(lo|docker|veth|br-|virbr)/.test(m[1])) continue;
                    const f = m[2].trim().split(/\s+/).map(Number);
                    rx += f[0] || 0; tx += f[8] || 0;
                }
                done(rx, tx);
            });
        }
    }

    _batteryTick() {
        if (IS_MAC) {
            execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 2000 }, (err, out) => {
                if (err || !out) return;
                const m = /(\d+)%;\s*([^;\n]+)(?:;\s*([^\n]*))?/.exec(out);
                if (!m) { this.other.bat = { none: true }; return; }
                const state = m[2].trim().toLowerCase();
                const t = /(\d+):(\d+) remaining/.exec(m[3] || '');
                const plugged = /AC Power/.test(out) || state === 'charging' || state === 'charged';
                this.other.bat = { pct: Number(m[1]), plugged, charging: state === 'charging' || state === 'finishing charge',
                    mins: t && !plugged ? Number(t[1]) * 60 + Number(t[2]) : null };
            });
        } else {
            try {
                const dir = '/sys/class/power_supply';
                const b = fs.readdirSync(dir).find(n => /^BAT/.test(n));
                if (!b) { this.other.bat = { none: true }; return; }
                const pct = Number(fs.readFileSync(`${dir}/${b}/capacity`, 'utf8'));
                const st = fs.readFileSync(`${dir}/${b}/status`, 'utf8').trim().toLowerCase();
                this.other.bat = { pct, plugged: st !== 'discharging', charging: st === 'charging', mins: null };
            } catch (_) { this.other.bat = { none: true }; }
        }
    }

    // ----- shared tick -----
    _tick() {
        if (IS_MAC) this._macTick();
        if (!IS_WIN) {
            if (this.want.net) this._netTick(); else { this.netPrev = null; this.other.net = null; }
            if (this.want.battery && (!this.batAt || Date.now() - this.batAt > 5000)) { this.batAt = Date.now(); this._batteryTick(); }
        }
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

        // Network: bytes per second received / sent
        let net = null;
        if (ps && ps.net && typeof ps.net.rx === 'number') net = { rx: ps.net.rx, tx: ps.net.tx };
        if (!IS_WIN && this.other.net) net = this.other.net;

        // Battery: null = not known yet, { none } = this computer has no battery
        let bat = null;
        if (ps && ps.bat === 0) bat = { none: true };
        else if (ps && ps.bat && typeof ps.bat.c === 'number') bat = winBattery(ps.bat);
        if (!IS_WIN && this.other.bat) bat = this.other.bat;

        // FPS: Windows only, from RivaTuner Statistics Server
        let fps = null;
        if (!IS_WIN) fps = { on: false, unsupported: true };
        else if (ps && ps.fps) fps = { on: !!ps.fps.on, fps: typeof ps.fps.fps === 'number' ? ps.fps.fps : null, ms: typeof ps.fps.ms === 'number' ? ps.fps.ms : null };

        const sample = { t: now, cpu, ramUsed, ramTotal, gpu, vramUsed, vramTotal, disks, space, net, bat, fps, live: IS_WIN ? !!ps : true };
        this.history.push(sample);
        if (this.history.length > 15) this.history.shift();
        for (const fn of this.listeners) { try { fn(sample, this.history); } catch (e) { this.log('listener', String(e && e.stack || e)); } }
    }
}

// ---------- helpers ----------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// Win32_Battery: BatteryStatus 1 = discharging, 2 = on AC, 3 = full, 4/5 = low/critical,
// 6-9 = charging, 11 = partly charged. EstimatedRunTime is minutes, 71582788 = unknown.
function winBattery(b) {
    const plugged = [2, 3, 6, 7, 8, 9, 11].includes(b.s);
    const pct = clamp(b.c, 0, 100);
    const charging = (b.s >= 6 && b.s <= 9) || (b.s === 2 && pct < 99);
    const mins = !plugged && b.m > 0 && b.m < 100000 ? b.m : null;
    return { pct, plugged, charging, mins };
}

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
