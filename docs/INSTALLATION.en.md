# How to Install WattPost on ESP32

[← Main page](../README.en.md) · [Українська](INSTALLATION.md) · **English**

This guide is written for users who have never flashed an ESP32 or microcontrollers before. The entire setup is code-free and solder-free: the ESP32 communicates with your JK BMS purely wirelessly over Bluetooth Low Energy.

---

## 1. What You Need

- **ESP32 Development Board**  
  A classic **ESP32-WROOM-32** or **ESP32-WROOM-32D DevKit** with **4 MB Flash memory** and an onboard USB port (Micro-USB or Type-C).  
  *Incompatible: bare modules without USB, or boards using different chips (ESP32-C3, ESP32-S3, etc. — currently a classic ESP32 is required).*
- **Battery Pack with a Compatible JK BMS**  
  Any modern JK BMS (JK-B1A..., JK-B2A..., JK-BD... series) equipped with **Bluetooth LE**.
- **USB Data Cable**  
  *Crucial: cheap charge-only cables do not carry USB data lines and your computer will not detect the board.*
- **Computer** running Windows, Linux, or macOS.
- **2.4 GHz Home Wi-Fi Network** (ESP32 hardware supports 802.11 b/g/n 2.4 GHz; 5 GHz Wi-Fi networks are not supported by the chip).

The ESP32 is powered from any standard 5V USB phone charger or power adapter (1A or higher). Connecting the ESP32 directly to the high-voltage battery terminals is **strictly prohibited**.

---

## 2. Download the Firmware Binary

Navigate to the **[GitHub Releases](https://github.com/DJZeuS21/WattPost-ESP32/releases)** section and download:

👉 **`WattPost-ESP32-full.bin`**

This is a single merged image designed for the initial USB installation: it already bundles the bootloader, partition table, initial OTA data, and the WattPost firmware. You do not need to download multiple binary files or calculate flash address offsets.

> [!NOTE]
> This merged binary is intended for the **initial installation on a new board**. Once WattPost is installed, future firmware updates are performed wirelessly and securely via Over-The-Air (OTA) updates right from the web interface, without needing a USB cable.

---

## 3. Connect the ESP32 to Your Computer

Plug the ESP32 into your computer via USB and identify the virtual COM port:

- **Windows**: Right-click the Start menu → **Device Manager** → expand **Ports (COM & LPT)**. Look for an entry such as `Silicon Labs CP210x USB to UART Bridge (COM3)` or `USB-SERIAL CH340 (COM4)`. Note down the port name (e.g. `COM3` or `COM4`).
- **Linux**: Open a terminal and run `ls /dev/ttyUSB* /dev/ttyACM*`. The board usually appears as `/dev/ttyUSB0` or `/dev/ttyACM0`.
- **macOS**: The port will appear as `/dev/cu.usbserial-...` or `/dev/cu.SLAB_USBtoUART`.

> [!TIP]
> If your computer does not react when plugged in or shows an unknown device, install the driver for the USB-to-UART chip on your board:
> - For **CP2102 / CP2104**: [official Silicon Labs CP210x VCP driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)
> - For **CH340 / CH341**: [official WCH CH340 driver](https://www.wch-ic.com/downloads/CH341SER_ZIP.html)

---

## 4. Flash Firmware via USB

We use Espressif's official, open-source command-line tool **`esptool`**.

1. Ensure [Python](https://www.python.org/downloads/) (version 3.8 or newer) is installed on your computer. During Windows installation, check the box **"Add python.exe to PATH"**.
2. Open a terminal (Command Prompt, PowerShell, or bash) and navigate to the directory where you downloaded `WattPost-ESP32-full.bin`.
3. Install `esptool`:
   ```bash
   pip install esptool
   ```
4. Flash the binary. Replace `PORT` with your board's serial port (e.g. `COM4` on Windows or `/dev/ttyUSB0` on Linux):
   ```bash
   python -m esptool --chip esp32 --port PORT --baud 460800 write-flash --flash-mode dio --flash-freq 40m --flash-size 4MB 0x0 WattPost-ESP32-full.bin
   ```
   *(On Linux or macOS, use `python3` instead of `python`).*

5. **Flash address `0x0`**: Because `WattPost-ESP32-full.bin` is a complete full-flash image, it is written starting at the very beginning of the flash memory (`0x0`).
6. Wait 20–30 seconds until the terminal displays **"Hash of data verified. Leaving... Staying in bootloader"**.
7. Press the **EN** (or **RESET**) button on your ESP32 board to restart it in normal run mode.

> [!TIP]
> If `esptool` reports "A fatal error occurred: Failed to connect to ESP32: No serial data received":
> 1. Lower the baud rate from `460800` to `115200` (using `--baud 115200`).
> 2. On certain dev boards, when `Connecting.....` appears, press and hold the hardware **BOOT** button on the board for 2–3 seconds until writing begins, then release it.

---

## 5. First Setup: Wi-Fi and JK BMS

On first boot, the ESP32 broadcasts its own Wi-Fi access point for guided setup from your phone or laptop.

![WattPost First Setup Wizard](screenshots/first-setup.png)
*WattPost setup wizard screen (First Setup)*

1. Open the Wi-Fi settings on your phone or laptop.
2. Find and connect to the network named **`WattPost-XXXX`** (where XXXX is unique to your board).
3. Enter the default setup password: **`12345678`**.
4. Most smartphones will automatically open the captive portal login screen. If it does not open automatically, navigate to:  
   👉 **http://192.168.4.1/**
5. Click **"Get Started"**:
   - **Step 1 — Wi-Fi**: Select your 2.4 GHz home Wi-Fi network from the list (or click "Scan"), enter the network password, and click "Connect". The ESP32 verifies the connection and obtains an IP address on your home LAN.
   - **Step 2 — JK BMS**: The wizard will scan for nearby Bluetooth devices. Select your JK BMS from the list and confirm.
6. Click **"Finish"**. The ESP32 saves the settings, disables the temporary setup AP, and switches to normal operating mode.

> [!IMPORTANT]
> **Important JK BMS Bluetooth Limitation:**  
> Most JK BMS units can only maintain **one active Bluetooth connection at a time**. If the official JK BMS mobile application is currently connected to the battery on your phone, disconnect and close the app. Otherwise, the BMS will appear busy and the ESP32 will not be able to connect.

---

## 6. Accessing Local Monitoring (http://bms.local/)

Once setup is complete, reconnect your phone or computer to your normal home Wi-Fi and visit:

🌐 **http://bms.local/**

You will see the WattPost live dashboard displaying your battery's state in real time!

### What if bms.local does not load?
The `bms.local` hostname uses mDNS (Bonjour / Avahi). Modern Apple devices, Linux, Windows 10/11, and modern Android versions resolve it out of the box.  
If your router or device fails to resolve mDNS names:
1. Locate the IP address assigned by your router to the ESP32 (displayed on the final step of the setup wizard, or visible in your router's DHCP client list under device name `wattpost`).
2. Open the interface directly using its IP address: for example, **`http://192.168.1.120/`**.
3. We recommend binding a static IP address to the ESP32's MAC address in your router DHCP settings for convenience.

---

## 7. Connecting to WattPost Cloud (Optional)

If you would like to monitor your battery from outside your home network:
1. Register a free account at **[wattpost.pp.ua](https://wattpost.pp.ua)**.
2. In the WattPost local web interface, navigate to the "Settings" tab → "WattPost Cloud" section.
3. Click "Pair Device" and follow the on-screen instructions.

WattPost Cloud allows viewing multiple batteries from different locations in one unified dashboard and enables automated, verified Over-The-Air (OTA) updates.

---

## 8. Troubleshooting

| Symptom | Probable Cause | Recommended Action |
|---|---|---|
| Computer does not detect ESP32 port | Charge-only USB cable or missing driver | Test with another data-capable USB cable; install CP2102 or CH340 driver. |
| esptool connection error | Board did not enter bootloader mode | Hold the BOOT button while connecting starts; lower baud rate to 115200. |
| No WattPost-XXXX Wi-Fi network appears | Insufficient power or flashing incomplete | Ensure stable 5V 1A+ USB power; press the EN/RESET button on the board. |
| Phone displays "No internet connection" on WattPost-XXXX | Normal behavior for an isolated setup AP | Keep the connection active; temporarily disable mobile cellular data while setting up. |
| JK BMS is not discovered during scan | BMS is connected to another phone or out of range | Close the JK app on any phone; bring ESP32 within 5–10 m (15–30 ft) of the battery. |
| bms.local does not open | Client lacks mDNS support or is on guest Wi-Fi | Ensure you are on the same 2.4 GHz subnet; open using direct IP (e.g. `http://192.168.1.50/`). |
| Telemetry shows "Waiting for BMS" | Battery switched off or BMS went to sleep | Verify battery power switch; ensure no mobile phone holds an active BLE session to the BMS. |
