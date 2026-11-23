<div align="center">

![Social banner](screenshots/social-banner-metrick.jpg)

# 📈 Metrics

**CPU, RAM, GPU, VRAM, disk, network, battery and FPS, live on your Stream Dock keys**

[![Download](https://img.shields.io/badge/⬇_Download-ZIP-2ecc71?style=for-the-badge)](https://github.com/cherry-terry/ajazz-system-metrics/archive/refs/heads/main.zip)

![Device](https://img.shields.io/badge/device-Ajazz_AKP03E_%7C_any_Stream_Dock-3ddc84)
![Platform](https://img.shields.io/badge/platform-Windows_%7C_macOS-0078d4)
![No drivers](https://img.shields.io/badge/drivers-not_needed-3ddc84)
![License](https://img.shields.io/github/license/cherry-terry/ajazz-system-metrics)

<img src="screenshots/keys.png" alt="Metrics keys" width="720">

</div>

---

## ✨ Features

- 📊 **Eight live readings**: CPU, RAM, GPU, VRAM, disk, network, battery and FPS, updated every second.
- 🎨 **Four styles**: color bar, monochrome, number only, or a 15-second graph.
- 🔥 **Color thresholds**: green when calm, through yellow and amber to red, plus a glow when the load is pegged.
- 👆 **Tap to switch units**, hold to open Task Manager, File Explorer and more.
- 🪶 **Light**: all keys share one reading, so ten keys cost no more than one. No drivers, no admin prompt, no account, no background service.
- 🍎 **Windows and macOS**.

## 📦 Installation

> [!IMPORTANT]
> Quit Stream Dock completely, including the tray icon, before copying files.

1. Copy the `com.diy.metrics.sdPlugin` folder to:
   - **Windows:** `%APPDATA%\HotSpot\StreamDock\plugins\`
   - **macOS:** `~/Library/Application Support/HotSpot/StreamDock/plugins/`
2. Start Stream Dock.
3. Drag actions from the **Metrics** category onto your keys.

## 🎛️ Keys

| Key | Reading | Tap | Hold (0.5 s) opens |
|---|---|---|---|
| **CPU** | Processor load, the same number Task Manager shows | — | Task Manager or Resource Monitor |
| **RAM** | Memory in use | GB ↔ % | Task Manager or Resource Monitor |
| **GPU** | Graphics load for Intel, AMD and NVIDIA (Apple silicon on a Mac) | — | Task Manager or Resource Monitor |
| **VRAM** | Video memory in use against the card's total (GPU MEM on a Mac) | GB ↔ % | Task Manager or Resource Monitor |
| **Disk** | How busy a drive is, how full it is, or how much is free | Activity → used → free | The drive in File Explorer or Storage settings |
| **Network** | Download, upload, or both at once | Download → upload → both | Resource Monitor or Network settings |
| **Battery** | Charge, charging state, or time left on a laptop | % ↔ time left | Power and battery settings |
| **FPS** | Frame rate or frame time of the game in front, from RivaTuner ([see below](#-fps)) | fps ↔ ms | The FPS setup guide (this page) |

On a Mac, hold opens Activity Monitor, Finder, System Settings or System Information. You choose what each key opens in its settings.

## ⚙️ Settings

<img src="screenshots/settings.png" alt="Settings" width="720">

| Setting | Options |
|---|---|
| **Style** | Color bar, monochrome, number only, 15-second graph |
| **Unit / Show** | GB or % for RAM and VRAM. Activity, used or free space for Disk |
| **Drive** | Which drive the Disk key watches |
| **Full bar at** | Network: your internet speed in Mbit/s (default 500). FPS: frame rate for a full bar (default 144) |
| **Hold opens** | What a half-second hold launches |
| **Calm below** | Green under this value (default 30 %) |
| **Red from** | Red from this value (default 85 %) |
| **Glow from** | Glowing red frame from this value (default 97 %) |
| **Colors** | Calm, warm and load colors are all yours to change |

Battery and FPS are bad when they are low, so their thresholds count down: Battery is calm above 50 % and red below 20 %, FPS is calm from 60 fps and red below 30 fps. Network has no glow by default, because busy traffic is not a problem.

## 🎮 FPS

The FPS key reads the frame rate from **RivaTuner Statistics Server (RTSS)**, the overlay that comes with **MSI Afterburner**. The plugin does not install, bundle or start RTSS, and it does not hook into games itself.

> [!IMPORTANT]
> RTSS is third-party software. You install it yourself, from its official source, and you use it at your own risk. The author of this plugin is not responsible for RTSS, MSI Afterburner, or how they behave with your games or anti-cheat systems.

**What to download**

| Program | Where | Needed? |
|---|---|---|
| **RivaTuner Statistics Server (RTSS)** | [guru3d.com: RTSS download](https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download/) | Yes, this is what the key reads |
| **MSI Afterburner** | [msi.com/Landing/afterburner](https://www.msi.com/Landing/afterburner) | Optional. Its installer offers RTSS, so you can get both at once |

RTSS on its own is enough. Download it only from these official pages.

**Set it up**

1. Install RTSS (or MSI Afterburner and tick RivaTuner Statistics Server during its setup).
2. Start RTSS. It sits in the tray, next to the clock. In its window, turn on **Start with Windows** so you do not have to start it every time.
3. Leave **Show On-Screen Display** on or off as you like; the key works either way, as long as RTSS is running.
4. Start a game. The FPS key shows the frame rate of the game in the foreground. A tap switches to frame time in ms.

**What the key shows**

| Key says | Meaning |
|---|---|
| `RTSS not running` | RTSS is closed. Start it. A hold on the key opens this page. |
| `—` and `no game` | RTSS is running, but no game with its overlay is in front. |
| `Windows only` | RTSS exists for Windows only, so the key has nothing to read on a Mac. |

The plugin only reads the statistics RTSS already publishes for its own overlay, so it adds no load to the game. If RTSS cannot hook a game (some anti-cheat systems block it), the key shows `no game`.

## 🔧 How it works

All keys share one reading per second. On Windows, a single hidden PowerShell process reads the built-in performance counters through WMI, the same counters Task Manager uses, and, when RTSS is running, its frame rate statistics. It exits with Stream Dock and stops when no Metrics key is on the device. On a Mac, network and battery come from `netstat` and `pmset`.

## 🛠️ Troubleshooting

### Quick table

| Problem | Fix |
|---|---|
| GPU or VRAM shows `—` | Windows 10 version 1709 or newer is required. |
| VRAM total is wrong | Enter it manually in the key settings. |
| Disk activity shows `—` or 0 all the time, but used and free space work | Windows disk counters are switched off. See [Disk activity does not show](#disk-activity-does-not-show). |
| Disk key on macOS shows space only | Disk activity needs root on macOS, so only space is available. |
| Network shows more or less than expected | Virtual adapters (Hyper-V, VirtualBox, VMware, WSL) are left out so traffic is not counted twice. |
| Battery says `No battery` | The computer has no battery, which is normal for a desktop. |
| FPS says `RTSS not running` | Start RivaTuner Statistics Server. See [FPS does not show](#fps-does-not-show). |
| FPS shows `—` and `no game` | RTSS is running but has no game to measure. See [FPS does not show](#fps-does-not-show). |
| FPS says `Windows only` | RTSS does not exist for macOS. |
| Nothing changes after copying new files | Quit Stream Dock completely, including the tray icon, then copy the folder again. |

### Disk activity does not show

The key reads disk activity from the performance counters built into Windows, the same ones Task Manager uses. "Cleaner", "optimizer" and "debloat" tools, some lite Windows builds, or a broken update can switch them off. Nothing is harmed by this, Windows just stops collecting disk statistics. Turning them back on is safe: it is the normal Windows default and costs no noticeable performance.

**Check.** Open PowerShell and run:

```powershell
Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Select Name, PercentIdleTime
```

If it prints your disks, the counters are fine. If it says `Invalid class`, they are switched off.

**Fix.**

1. Right-click **Start** and choose **Terminal (Admin)** or **Windows PowerShell (Admin)**. It must be an administrator window: in a normal one the first command fails with `error code is 5` (access denied).
2. Run these one by one:

   ```powershell
   lodctr /R
   lodctr /E:PerfDisk
   lodctr /E:Tcpip
   winmgmt /resyncperf
   ```

   `lodctr /R` rebuilds the counter settings from Windows' own backup, the next two switch the disk and network counters on, and the last one tells WMI about them. The last command prints nothing, that is normal.
3. Restart the computer. The check above now lists your disks, and the Disk key shows activity.

### FPS does not show

| Key says | What to do |
|---|---|
| `RTSS not running` | RTSS is not installed or not started. Install it (see [What to download](#-fps)) and start it. Check that its icon is in the tray. |
| `—` and `no game` | The game is not in front, or RTSS cannot hook it. Click into the game window. In RTSS, make sure **Application detection level** is not set to **None**. Some games with anti-cheat block RTSS; then the key cannot show FPS for that game. |
| Number is frozen or wrong | Restart RTSS, then the game. Fullscreen and borderless both work. |
| `Windows only` | RTSS exists for Windows only. |

The plugin only reads statistics RTSS already publishes for its own overlay. It does not inject anything into games.

### Network shows 0

Network speed is measured from the byte counters of every network adapter that is up, so it needs no extra setup. If it stays at 0 while you download something, check that the adapter you use is not a virtual one (Hyper-V, VirtualBox, VMware, WSL), because those are skipped on purpose. If it still does not work, send the plugin log.

Plugin log: `com.diy.metrics.sdPlugin\plugin\log\plugin.log`

## 📄 License

[MIT](LICENSE). Not affiliated with Ajazz.
