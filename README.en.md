# WattPost

[Українська](README.md) · **English**

WattPost is firmware for the ESP32 that connects to a JK BMS over Bluetooth and displays information about your battery in a regular web browser.

The ESP32 reads the state of charge, voltage, current, temperature, and individual cell data from the BMS. The web interface shows live readings, battery history, and information about BMS settings.

## How it works

1. The JK BMS monitors your battery and provides data over Bluetooth Low Energy (BLE).
2. The ESP32 running WattPost reads that data and stores a local history.
3. You open WattPost in a browser on your Wi-Fi network to see the battery's readings.

## Local access

The ESP32 connects to your Wi-Fi network and serves the web interface at **http://bms.local/** (or at the device's IP address). You can view live readings and battery history from a phone or computer on the same network.

Local monitoring doesn't require an account, a separate server, or an internet connection. Even if WattPost Cloud is unavailable, the ESP32 keeps reading data from the BMS and recording history.

## Cloud access

If you want to check your battery when you're away, you can connect the ESP32 to **[WattPost Cloud](https://wattpost.pp.ua)** for free.

Once you've signed up, you can check your battery over the internet from another location. One account can have multiple ESP32 devices — for example, one at home, another at work, and another elsewhere.

Cloud access is optional. The local web interface works independently.

## Firmware updates

WattPost is still being developed. When we fix bugs or make improvements, we can publish new firmware versions.

If your ESP32 is connected to WattPost Cloud and automatic updates are enabled, the device checks for newly published versions and installs them over the internet (OTA). You don't need to connect the ESP32 to a computer for each such update.

You can turn off automatic updates and install available versions manually instead. Before installation, the ESP32 verifies the firmware's integrity and digital signature.

## What you need

- An ESP32-WROOM-32D or compatible classic ESP32 with 4 MB of flash.
- A battery with a supported **JK BMS** and Bluetooth LE.
- A Wi-Fi network to access the web interface.

WattPost is a monitoring tool. It does not replace the BMS or its built-in battery protection.

## Repository status

We're starting with the project description. Firmware source code, installation instructions, and release files will be added later. **There is no firmware available for download from this repository yet.**

License terms will be published alongside the source code.
