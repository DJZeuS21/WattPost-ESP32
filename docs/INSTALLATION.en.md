# How to install WattPost on an ESP32

[← Main page](../README.en.md) · [Українська](INSTALLATION.md) · **English**

This guide is for anyone who has never used an ESP32 before. No soldering is needed: the ESP32 reads the JK BMS over Bluetooth.

> **Important:** ready-to-flash firmware files are not yet available in [Releases](https://github.com/DJZeuS21/WattPost-ESP32/releases). The instructions below explain how installation will work once the first package is published. Don't flash random BIN files from the internet.

## 1. What you'll need

- An **ESP32-WROOM-32D DevKit**, or a compatible classic ESP32 development board with **4 MB flash** and a USB port. A bare module without USB is less suitable for beginners.
- A battery with a compatible **JK BMS** supporting **Bluetooth Low Energy (BLE)**.
- A **USB data cable** (some cables only charge).
- A Windows, Linux, or macOS computer for the first installation.
- A **2.4 GHz Wi-Fi** network.

You can power the ESP32 from a normal USB charger. No wires between the ESP32 and the battery or BMS are needed.

## 2. Download the firmware

When the first release becomes available, open [GitHub Releases](https://github.com/DJZeuS21/WattPost-ESP32/releases) and download the package **for a classic ESP32 with 4 MB flash**.

The current WattPost build uses these four files:

| File | Flash address |
| --- | --- |
| `bootloader/bootloader.bin` | `0x1000` |
| `partition_table/partition-table.bin` | `0x8000` |
| `ota_data_initial.bin` | `0xF000` |
| `wattpost_mini.bin` | `0x20000` |

Extract everything into one folder, **keeping the directory structure**. If a future release provides an easier installer, follow that release's instructions.

**This procedure is for the first installation on a new board.** If your ESP32 already runs WattPost and has settings or history, use its built-in OTA update instead. Don't write the full set of images without a backup and a plan to preserve data.

## 3. Connect the ESP32 over USB

Connect the board to your computer and find its serial port:

- **Windows:** Device Manager → Ports (COM & LPT), for example `COM4`.
- **Linux:** usually `/dev/ttyUSB0` or `/dev/ttyACM0`.
- **macOS:** usually `/dev/cu.usbserial-…` or `/dev/cu.SLAB_USBtoUART`.

If no port appears, try another USB cable first. Some boards need a USB-to-serial driver such as CP210x or CH340, depending on the board.

## 4. Flash the firmware over USB

We'll use **esptool**, Espressif's official flashing utility. You don't need Arduino IDE or programming experience.

1. Install [Python](https://www.python.org/downloads/) if necessary.
2. Open a terminal or command prompt **inside the directory containing the extracted firmware files**.
3. Install esptool:

   ```bash
   python -m pip install esptool
   ```

4. Run the command below. Replace **PORT** with your ESP32 serial port, such as `COM4` or `/dev/ttyUSB0`:

   ```bash
   python -m esptool --chip esp32 --port PORT --baud 460800 write-flash --flash-mode dio --flash-freq 40m --flash-size 4MB 0x1000 bootloader/bootloader.bin 0x8000 partition_table/partition-table.bin 0xF000 ota_data_initial.bin 0x20000 wattpost_mini.bin
   ```

   If `python` isn't available, use `py` on Windows or `python3` on Linux/macOS.

5. Wait for the successful completion message. Press **EN/RESET** if the board doesn't restart automatically.

**Don't change these flash addresses.** WattPost's application starts at `0x20000`, not the `0x10000` address often used in generic ESP32 tutorials.

If esptool can't connect, try changing `460800` to `115200`. Some boards require holding **BOOT** as the connection starts and releasing it once connected.

Don't run `erase-flash`: erasing the entire flash removes stored data.

Official reference: [Espressif — Flashing Firmware](https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/flashing-firmware.html).

## 5. Set up Wi-Fi and JK BMS

On first boot, the ESP32 opens its own Wi-Fi network for setup:

1. On your phone or computer, find **`WattPost-XXXX`** (the last characters vary between boards).
2. Connect to it. The initial setup-network password in the current firmware is **`12345678`**.
3. If the setup wizard doesn't open automatically, visit **http://192.168.4.1/**.
4. Select your home Wi-Fi, enter its password, and wait for confirmation.
5. The wizard offers to find your **JK BMS** over Bluetooth. Select the correct BMS and wait for readings. If it's unavailable, you can finish Wi-Fi setup and add the BMS later.
6. Reconnect to your home Wi-Fi and open **http://bms.local/**. If the name doesn't work, use the ESP32's IP address from the setup wizard or your router.

That's it: live readings and history work **locally, without an account or internet connection**. You can optionally link the device to [WattPost Cloud](https://wattpost.pp.ua) for remote monitoring.

## Troubleshooting

- **Computer can't detect ESP32:** check the USB data cable, USB port, and USB-to-serial driver.
- **Flashing error:** double-check PORT and all four files, reduce the baud rate, or try BOOT during connection.
- **No WattPost-XXXX network:** check USB power and that flashing completed.
- **Phone says “No internet”:** that's normal on the setup network. Stay connected and visit `192.168.4.1`.
- **bms.local doesn't load:** check you're on the same home network or use the ESP32's IP address.
- **JK BMS isn't found:** check its Bluetooth, distance, and whether another device is holding the connection.

WattPost displays monitoring data only. **Don't connect the ESP32 to the battery's power terminals:** the BMS is responsible for battery protection.
