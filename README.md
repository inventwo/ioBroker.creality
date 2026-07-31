![Logo](admin/creality.png)

# ioBroker adapter for CREALITY 3D printer

![Number of Installations](https://iobroker.live/badges/creality-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/creality-stable.svg)
[![NPM Version](https://nodei.co/npm/iobroker.creality.svg?style=shields&data=v,u,d&color=orange)](https://www.npmjs.com/package/iobroker.creality)
[![Downloads](https://img.shields.io/npm/dm/iobroker.creality.svg)](https://www.npmjs.com/package/iobroker.creality)

[![COMMUNITY](https://img.shields.io/badge/community%20-ioBroker%20|%20forum-blue.svg)](https://forum.iobroker.net)
[![MAINTAINER](https://img.shields.io/badge/maintainer-skvarel%20@%20inventwo-yellowgreen.svg)](https://github.com/skvarel)
[![AI](https://img.shields.io/badge/ai%20assisted-cursor-blue.svg)](https://github.com/inventwo/ioBroker.motioneye/blob/main/.cursor/iobroker-adapter.mdc)

[![Paypal Donation](https://img.shields.io/badge/paypal-donate%20|%20spenden-green.svg)](https://www.paypal.com/donate/?hosted_button_id=7W6M3TFZ4W9LW)

---

## What this adapter does

Connects Creality Klipper printers (primary target: **SPARKX i7** with CFS lite) to ioBroker via two local APIs:

1. **Moonraker HTTP** (default port `7125`) — print stats, temperatures, fans, CFS filament box, G-code
2. **Creality WebSocket** (default port `9999`) — toolhead LED, pause / resume / stop, leveling / self-test UI state, remaining time (`printLeftTime`)

Moonraker alone is not enough for Creality UI states (e.g. leveling while Klipper still reports `standby`) or the toolhead light.

Other Creality Klipper models may work best-effort; only SPARKX i7 has been tested so far.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Host / IP | — | Printer address (required) |
| Moonraker HTTP port | `7125` | Fluidd reverse proxy often uses `4408` |
| Creality WebSocket port | `9999` | Toolhead LED & print controls |
| Poll interval | `5` s | Moonraker poll (min. 2 s) |
| API key | empty | Optional Moonraker auth |
| Print controls / CFS / Fans | on | Feature toggles for state tree |

One printer per adapter instance.

## Data points

Under `creality.<instance>.*` (examples):

| State | Description |
|-------|-------------|
| `info.connection` | Connected (Moonraker or Creality WS) |
| `info.model` | Printer model (e.g. `SPARKX i7`) |
| `info.firmware` | Creality firmware version (e.g. `1.1.5.4`) |
| `info.printHours` | Total print hours (`h`) |
| `state` | UI print state (`printing`, `leveling`, `self-testing`, …) |
| `stateKlipper` | Raw Moonraker / Klipper `print_stats.state` |
| `selfTestStep` | Creality self-test phase (`0` idle, `5` leveling; other numbers = unknown phase) |
| `progress` | Progress % |
| `printName` | Print file name |
| `remainingText` / `finishAt` | Remaining / finish time |
| `filamentSlot` / `filamentMaterial` / `filamentColor` | Active CFS filament |
| `temp.*` | Nozzle / bed temperatures |
| `fans.*` | Fan % / RPM (optional) |
| `cfs.*` | CFS box + slots T1A–T1D + box LED (optional) |
| `control.light` / `pause` / `resume` / `stop` | Writable controls (optional) |

Prototype reference used while developing: `scripts/iobroker-print-status.js`.

## Support


If you like our work and would like to support us, we appreciate any donation.
(This link leads to our PayPal account and is not affiliated with ioBroker.)

[![Donate](img/support.png)](https://www.paypal.com/donate?hosted_button_id=7W6M3TFZ4W9LW)

## Changelog

<!--
  ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (skvarel) Added Moonraker + Creality WebSocket adapter for SPARKX i7 / CFS
- (skvarel) Added print status, temps, fans, CFS slots, and print controls
- (skvarel) Added `info.model`, `info.firmware`, and `info.printHours`
- (skvarel) Fixed adapter icon (`creality_icon.png`)
- (skvarel) Added value list for `selfTestStep` (known phases)


## Older changes
- [CHANGELOG_OLD.md](CHANGELOG_OLD.md)

## License
MIT License

Copyright (c) 2026 skvarel <skvarel@inventwo.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.