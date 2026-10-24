# WattPost

[Українська](README.md) · **English**

**WattPost** is ESP32 firmware that wirelessly connects to a **JK BMS** over Bluetooth Low Energy (BLE) and serves a modern, responsive battery monitoring interface directly in any web browser.

Designed for DIY battery builders, home solar energy storage systems, and backup power (UPS) setups using LiFePO4, NMC, or LTO batteries with JK BMS. WattPost frees you from needing to stand near the battery with the JK mobile app open — your battery energy state is accessible from any smartphone, tablet, or PC on your local network.

---

## WattPost Interface

![WattPost Main Dashboard](docs/screenshots/dashboard.png)
*WattPost main monitoring screen (Dashboard). Rendered from the authentic web interface running safe 16S LiFePO4 demonstration telemetry.*

---

## Key Features

- **Real-Time Energy Dashboard**
  Live energy flow animation (charging, discharging, or idle states), State of Charge (SOC %), total battery pack voltage, current, and active power in Watts. Interactive cell voltage bars with automatic highlight of the highest and lowest cells, active balancing indicator, and cell delta (spread in millivolts).

- **14-Day On-Device History**
  The ESP32 logs data directly to its internal Flash memory without requiring an SD card or external server. Interactive charts for voltage, current, power, temperatures, and cell spread allow you to zoom in and analyze charge/discharge cycles. History is preserved across device reboots.

- **JK BMS Settings Inspector**
  Clean, structured read-only display of configured JK BMS parameters: overvoltage and undervoltage protection (OVP/UVP), active balancing start threshold and balance current, charge/discharge overcurrent limits, temperature cutoff thresholds, smart sleep timer, and BMS hardware/software versions.

- **Mobile-First Responsive Design**
  The interface adapts to phones and tablets: equally smooth and legible on a handheld smartphone or a large desktop monitor.

---

## How It Works

```mermaid
flowchart LR
    BMS["Battery with JK BMS"] -->|Bluetooth LE| ESP["ESP32 running WattPost"]
    ESP -->|Wi-Fi| WEB["Browser on phone or PC"]
```

1. **JK BMS** continuously monitors battery cells and provides telemetry to a connected device over Bluetooth Low Energy (BLE).
2. **ESP32** running WattPost firmware connects wirelessly to the BMS, parses telemetry frames, and records local history. ESP32 does not need a wired connection to the battery terminals to read BMS telemetry.
3. **Local Web Interface** is available from a phone or computer on the same network at `http://bms.local/` (or the ESP32 IP address).

---

## Local Access vs Cloud

| Feature | Local Mode (WattPost Local) | Cloud Access (WattPost Cloud) |
|---|---|---|
| **Access URL** | `http://bms.local/` or local IP | [wattpost.pp.ua](https://wattpost.pp.ua) |
| **Account / Sign-up** | **Not required** | Free account |
| **Internet Connection**| **Not required** (works offline) | Required for remote viewing |
| **Privacy** | Telemetry stays local unless you enable Cloud sync | Synchronized to secure Cloud storage |
| **Remote Access** | Local Wi-Fi network only | Anywhere in the world over the internet |
| **Multiple Batteries** | Accessed per ESP32 device | Multi-device fleet view in one dashboard |
| **Firmware Updates** | Via connected WattPost Cloud | Automatic or manual signed OTA updates |

> [!NOTE]
> The local web interface is fully functional and completely autonomous. Connecting to WattPost Cloud is **entirely optional**. If the Cloud or internet connection is unavailable, the ESP32 continues reading BMS metrics and recording history locally.

---

## Interface Gallery

<p align="center">
  <b>14-Day History & Analytics</b><br>
  <img src="docs/screenshots/history.png" alt="WattPost History charts" width="800">
</p>

<p align="center">
  <b>JK BMS Settings Inspection</b><br>
  <img src="docs/screenshots/bms-settings.png" alt="WattPost BMS Settings view" width="800">
</p>

<table align="center">
  <tr>
    <td align="center"><b>Mobile Dashboard</b></td>
    <td align="center"><b>First Setup Wizard</b></td>
  </tr>
  <tr>
    <td align="center" valign="top">
      <img src="docs/screenshots/dashboard-mobile.png" alt="Mobile Dashboard view" width="340">
    </td>
    <td align="center" valign="top">
      <img src="docs/screenshots/first-setup.png" alt="First Setup wizard" width="460">
    </td>
  </tr>
</table>

*All screenshots are captured from the genuine V20.0.1 web interface using safe demonstration telemetry (DEMO telemetry).*

---

## Hardware Requirements

1. **ESP32 Development Board** — Classic ESP32 (ESP32-WROOM-32 / ESP32-WROOM-32D DevKit) with **4 MB Flash** and a USB port. Powered from a standard 5V USB phone charger or power supply.
2. **Battery pack with a supported JK BMS** that has Bluetooth LE capability.
3. **2.4 GHz Wi-Fi network** to access the web interface.

> [!WARNING]
> WattPost is strictly a telemetry and monitoring system. It does not replace the hardware protection functions of the JK BMS itself. Never connect ESP32 GPIO pins directly to the high-voltage battery terminals!

---

## Quick Installation

New to ESP32? Follow our **[step-by-step beginner installation guide](docs/INSTALLATION.en.md)**.

1. Download the ready-to-flash image **`WattPost-ESP32-full.bin`** from [GitHub Releases](https://github.com/DJZeuS21/WattPost-ESP32/releases).
2. Connect your ESP32 to your computer using a USB data cable.
3. Flash the single image using `esptool` at offset **`0x0`**:
   ```bash
   python -m esptool --chip esp32 --port PORT --baud 460800 write-flash --flash-mode dio --flash-freq 40m --flash-size 4MB 0x0 WattPost-ESP32-full.bin
   ```
4. Connect your phone to the initial setup Wi-Fi network **`WattPost-XXXX`** (password: `12345678`), open **http://192.168.4.1/** in a browser, and select your home Wi-Fi and JK BMS.
5. Reconnect to your home Wi-Fi and open **http://bms.local/**.

---

## Firmware Updates (OTA)

- **Security & Integrity**: WattPost supports Over-The-Air (OTA) updates. Every official release is digitally signed by the maintainer. The ESP32 cryptographically verifies the signature before applying any new firmware binary.
- **Rollback Protection**: Dual OTA partitions ensure fault tolerance. If newly flashed firmware fails to boot or validate, the bootloader automatically reverts to the previous working partition.
- **No USB Required After Setup**: After the first USB installation, official updates can be installed wirelessly when ESP32 is connected to WattPost Cloud and the internet.

---

## Source Code & Local Build

The firmware and local web interface source code are located in [`esp32_monitor/`](esp32_monitor/).
- Built using the official **ESP-IDF 5.5.5** toolchain.
- Build instructions are available in [`esp32_monitor/README.md`](esp32_monitor/README.md).
- The WattPost Cloud backend is a proprietary service and is not part of this repository.
- Verification checksums and build provenance for the official release binary are documented in [Release Provenance](docs/RELEASE_PROVENANCE.md).

---

## License & Permitted Use

WattPost is distributed under the **[Apache 2.0 with Commons Clause](LICENSE)** license.

This is a **source-available** license, not OSI-defined Open Source:
- **Free for Personal and Internal Business Use**: You are free to use WattPost at home, in an office, shop, or within any business to monitor your own batteries; study and modify the source code; and share it free of charge.
- **Selling WattPost is Prohibited**: You may not resell the firmware, sell WattPost as a paid product or service, or sell pre-flashed commercial hardware based on WattPost without a separate commercial agreement from the rightsholder.

Third-party libraries and components retain their respective original licenses (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
