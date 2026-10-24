# WattPost

[Українська](README.md) · **English**

WattPost is firmware for the ESP32 that connects to a JK BMS over Bluetooth and displays information about your battery in a regular web browser.

The ESP32 reads the state of charge, voltage, current, temperature, and individual cell data from the BMS. The web interface shows live readings, battery history, and information about BMS settings.

## How it works

1. The JK BMS monitors your battery and provides data over Bluetooth Low Energy (BLE).
2. The ESP32 running WattPost reads that data and stores a local history.
3. You open WattPost in a browser on your Wi-Fi network to see the battery's readings.

## Local access

The ESP32 connects to your Wi-Fi network and opens its web interface at **http://bms.local/** (or at the device's IP address).

- You can view live readings and battery history from a phone or computer on the same network.
- Local monitoring doesn't require an account, a separate server, or an internet connection.
- If WattPost Cloud is unavailable, the ESP32 continues reading the BMS and recording history.

## Cloud access

If you'd like to check your battery when you're away, you can connect the ESP32 to **[WattPost Cloud](https://wattpost.pp.ua)** for free.

- After signing up, you can view your battery's readings over the internet, even when you're away from home.
- One account can have multiple ESP32 devices — for example, at home, in an office, or at another location.
- Cloud access is optional. The local web interface works without it.

## Firmware updates

WattPost is still being developed. New firmware versions may include bug fixes and improvements.

- If the ESP32 is connected to WattPost Cloud and automatic updates are enabled, it checks for newly published versions and installs them over the internet (OTA).
- You don't need to connect the ESP32 to a computer for these updates.
- You can turn off automatic updates and install available versions manually instead.
- Before installation, the ESP32 verifies the firmware's integrity and digital signature.

## What you need

- An ESP32-WROOM-32D or compatible classic ESP32 with 4 MB of flash.
- A battery with a supported **JK BMS** and Bluetooth LE.
- A Wi-Fi network to access the web interface.

WattPost is a monitoring tool. It does not replace the BMS or its built-in battery protection.
