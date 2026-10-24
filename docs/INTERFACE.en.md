# WattPost Interface

[← Project overview](../README.en.md) · [Українська](INTERFACE.md) · **English**

These are captures of the actual WattPost V20.0.1 local web interface. Every reading and identifier in the refreshed captures is synthetic; the device name includes `DEMO`. The scenario represents a 16S LiFePO4, 280 Ah pack, not an installed battery. Neither the interface design nor its code was changed for the screenshots.

## History: A Complete Day

![24-hour History with pack voltage detail and hourly load profile](screenshots/history.png)

The interval runs from 20:00 on 23 October to 20:00 on 24 October 2026, Kyiv time. 145 points cover 144 ten-minute intervals. Overnight demand gradually drains the pack, with short appliance peaks in the morning. Daytime charging varies with simulated solar generation and tapers near the upper charge limit. Evening loads then draw from the battery again.

For this day, the interface calculates approximately 9.3 kWh received and 9.1 kWh delivered, with state of charge ranging from 36% to 98%. The detail chart shows pack voltage: it sags under load and rises during charging. The daily table and heatmap also use older records, so they extend beyond the selected 24 hours.

History contains averaged values, which can smooth out peaks shorter than ten minutes. WattPost itself draws the colors, scales, lines and totals.

## History: A Week and Cell Spread

![Seven days of changing charge and discharge cycles, with cell voltage spread](screenshots/history-week.png)

1009 points cover seven days. Solar output and cloud cover vary between days, producing different cycle depths and daily charge maxima. The detail chart shows cell voltage spread instead of repeating power. The hourly map below compares morning and evening demand across 14 days; the final day is still incomplete.

## History: Temperature Response

![Daily History with MOSFET temperature selected in the detail chart](screenshots/history-temperature.png)

The same daily scenario, with power-switch (MOSFET) temperature selected. These switches react to higher current faster than the battery sensors. Heating and cooling have a time delay; temperature does not simply copy the power trace.

## Dashboard

![Full WattPost Dashboard with charge, discharge, temperature and 16-cell voltage charts](screenshots/dashboard-full.png)

The snapshot matches the end of the same history: 75% charge, approximately 600 W of load and 210 Ah remaining. Pack voltage equals the sum of cell voltages, and power is calculated from voltage and current.

## BMS Settings

![Demonstration BMS parameters: capacity, protection, balancing and temperature thresholds](screenshots/bms-settings.png)

All 53 parameters have explicitly assigned demonstration values. The name and serial number identify the example; these are not records or settings from a real device. Values illustrate the screen and are not battery configuration recommendations. You can browse and search the parameters; this screen cannot change them.

## On a Phone

<table>
  <tr><th>Dashboard</th><th>24-hour History</th></tr>
  <tr>
    <td valign="top"><img src="screenshots/dashboard-mobile.png" alt="Mobile Dashboard: state of charge, load and battery readings" width="300"></td>
    <td valign="top"><img src="screenshots/history-mobile.png" alt="Mobile History: daily totals, power and state of charge" width="300"></td>
  </tr>
</table>

Both captures use a 390-pixel-wide viewport and the same telemetry as the desktop views. They show the tops of scrollable pages; the remaining charts and tables continue below.

## First Setup

![WattPost setup wizard welcome screen](screenshots/first-setup.png)

The existing welcome-screen capture has been retained. Follow the [installation guide](INSTALLATION.en.md) for the connection steps.

[How to reproduce the demo and validate the data →](demo/README.md)
