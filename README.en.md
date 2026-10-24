# WattPost

[Українська](README.md) · **English**

WattPost is firmware for the ESP32 that connects to a JK BMS over Bluetooth and displays information about your battery in a regular web browser.

The ESP32 reads the state of charge, voltage, current, temperature, and individual cell data from the BMS. The web interface shows live readings, battery history, and information about BMS settings.

You don't need an account or a separate server for local monitoring. The ESP32 connects to your Wi-Fi network, and you can open the interface on a phone or computer at **http://bms.local/** (or at the device's IP address). An internet connection is not required.

## How it works

1. The JK BMS monitors your battery and provides data over Bluetooth Low Energy (BLE).
2. The ESP32 running WattPost reads that data and stores a local history.
3. You open WattPost in a browser on your Wi-Fi network to see the battery's readings.

For access when you're away, you can optionally connect your ESP32 to **[WattPost Cloud](https://wattpost.pp.ua)**. It's a free remote monitoring service. After signing up, you can check your battery over the internet and link multiple devices to one account, for example at home, at work, or at another location.

Cloud access is optional. Local monitoring continues to work independently of WattPost Cloud.

## What you need

- An ESP32-WROOM-32D or compatible classic ESP32 with 4 MB of flash.
- A battery with a supported **JK BMS** and Bluetooth LE.
- A Wi-Fi network to access the web interface.

WattPost is a monitoring tool. It does not replace the BMS or its built-in battery protection.

## Repository status

We're starting with the project description. Firmware source code, installation instructions, and release files will be added later. **There is no firmware available for download from this repository yet.**

License terms will be published alongside the source code.
