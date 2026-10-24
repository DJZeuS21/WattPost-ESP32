"""Deterministic synthetic battery telemetry. Never connects to a real device."""
from datetime import datetime, timezone
from math import exp, sin, pi, sqrt
from random import Random

END = int(datetime(2026, 10, 24, 17, tzinfo=timezone.utc).timestamp())  # 20:00 Kyiv
START = END - 14 * 86400
CAPACITY_AH = 280
SEED = 24102026


def generate():
    rng = Random(SEED)
    soc, battery_temp, mos_temp, cloud = 76.0, 24.0, 26.0, 0.8
    offsets = [-.56, .12, -.23, .34, -.10, .22, -.38, .46,
               -.18, .07, .28, -.31, .14, -.04, .39, -.22]
    offsets = [x - sum(offsets) / 16 for x in offsets]
    day_sun = [.87, .65, 1.0, .78, .94, .57, .98, .73, .90, .68, 1.0, .81, .93, .88, .96]
    rows, bucket = [], []
    for t in range(START - 540, END + 1, 60):
        day = max(0, (t - START) // 86400)
        hour = ((t + 3 * 3600) % 86400) / 3600
        minute = (t // 60) % 1440
        # Refrigerator/compressor cycling and modest, correlated household variation.
        load = 235 + (115 if minute % 47 < 18 else 0) + rng.uniform(-22, 22)
        if 6 <= hour < 9:
            load += 380
            if 7.0 <= hour < 7.34 or 8.10 <= hour < 8.27:
                load += 1650
        if 10.2 <= hour < 11.3 and day % 3 != 1:
            load += 720 * (1 if minute % 25 < 15 else .25)
        if 17 <= hour < 22:
            load += 360
            if 18.0 <= hour < 18.6 or 19.1 <= hour < 19.4:
                load += 1550
        daylight = max(0, sin(pi * (hour - 7.5) / 9.5)) if 7.5 < hour < 17 else 0
        if minute % 13 == 0:
            cloud = rng.uniform(.32, 1.0)
        # Variable solar surplus, with sustained cloudy intervals rather than white noise.
        solar = 3800 * daylight ** 1.25 * day_sun[day] * (.50 + .50 * cloud)
        if 11.5 < hour < 12.2 or (day % 2 == 0 and 14.0 < hour < 14.6):
            solar *= .32
        requested = solar - load
        # Simplified charge controller taper / low-SOC reserve; no artificial SOC clipping.
        if requested > 0:
            requested = min(requested, max(0, (98.5 - soc) * 150))
        elif soc < 20:
            requested *= max(0, (soc - 16) / 4)
        ocv = 16 * (3.23 + .0013 * soc + .065 * exp((soc - 100) / 6))
        resistance = .012
        current = (-ocv + sqrt(ocv * ocv + 4 * resistance * requested)) / (2 * resistance)
        voltage = ocv + resistance * current
        soc += current * (0.995 if current > 0 else 1) / 60 / CAPACITY_AH * 100
        ambient = 23 + 1.4 * sin(2 * pi * (hour - 9) / 24)
        battery_temp += (ambient + .0013 * current ** 2 - battery_temp) / 180
        mos_temp += (ambient + .007 * current ** 2 - mos_temp) / 22
        spread = 7 + abs(current) * .16 + max(0, soc - 87) * .7
        cells = [voltage / 16 + x * spread / 1000 + rng.uniform(-.0006, .0006) for x in offsets]
        bucket.append((current, soc, cells, [mos_temp, battery_temp - .4, battery_temp + .4]))
        if (t - START) % 600 == 0 and t >= START:
            n = len(bucket)
            cell_mv = [round(sum(b[2][i] for b in bucket) / n * 1000) for i in range(16)]
            rows.append(dict(t=t, v=round(sum(cell_mv) / 1000, 3),
                             a=round(sum(b[0] for b in bucket) / n, 1),
                             s=round(sum(b[1] for b in bucket) / n),
                             cell_mask=65535, cell_count=16, cells=cell_mv,
                             temp_mask=7,
                             temps=[round(sum(b[3][i] for b in bucket) / n * 10) for i in range(3)] + [None]*3))
            bucket = []
    last = rows[-1]
    cells = [v / 1000 for v in last['cells']]
    live = dict(online=True, model='DEMO · JK-B2A20S20P', semantic_profile='JK02_32S',
                voltage_v=last['v'], current_a=last['a'], soc=last['s'],
                remaining_capacity_ah=round(CAPACITY_AH * last['s'] / 100, 1),
                nominal_capacity_ah=CAPACITY_AH, cell_count=16, cell_active_mask=65535, cells=cells,
                bms_cell_delta_mv=max(last['cells']) - min(last['cells']),
                bms_cell_average_mv=round(sum(last['cells']) / 16),
                bms_min_cell_index=cells.index(min(cells)), bms_max_cell_index=cells.index(max(cells)),
                wifi_configured=True, wifi_state='connected', wifi_ssid='WattPost-DEMO', wifi_rssi_dbm=-51,
                bms_configured=True, ble_state='connected', ble_connected=True,
                device_config_status='ready', setup_state='complete',
                temperatures=[dict(id=id_, supported=True, present=True, enabled=True,
                                   value_valid=True, alias_of=None, val_c=last['temps'][i] / 10)
                              for i, id_ in enumerate(['mos', 't1', 't2'])])
    return rows, live


def settings():
    # Illustrative configuration, not a recommendation for any physical battery.
    return dict(valid=True, protocol_family='JK02_32S',
        device=dict(model='JK-B2A20S20P', device_name='WattPost DEMO · 16S LiFePO4',
                    device_sn='DEMO-NOT-A-REAL-SERIAL', hardware_version='11.3', software_version='15.1',
                    power_on_count=12, uptime_seconds=14*86400+7200),
        battery=dict(cell_count=16, nominal_capacity_ah=280, device_address=1,
                     chemistry='LFP', state_of_health=100),
        cell_voltage=dict(ovp_v=3.65, ovpr_v=3.50, request_charge_v=3.45, request_float_v=3.375,
                          soc_100_v=3.45, soc_0_v=2.90, start_balance_v=3.40, uvpr_v=3.0,
                          uvp_v=2.8, power_off_v=2.7, smart_sleep_v=3.3),
        balancing=dict(enabled=True, trigger_delta_v=.015, start_voltage_v=3.40, max_current_a=2.0),
        current_limits=dict(max_charge_a=100, charge_ocp_delay_s=10, charge_ocpr_time_s=60,
                            max_discharge_a=200, discharge_ocp_delay_s=10, discharge_ocpr_time_s=60,
                            scp_delay_us=150, scpr_time_s=60, discharge_precharge_s=5),
        temperature=dict(charge_otp_c=55, charge_otpr_c=50, charge_utp_c=0, charge_utpr_c=5,
                         discharge_otp_c=60, discharge_otpr_c=55, discharge_utp_c=-20,
                         discharge_utpr_c=-15, mosfet_otp_c=80, mosfet_otpr_c=70,
                         heating_start_c=2, heating_stop_c=8),
        switches=dict(charge=True, discharge=True, balancer=True, heating=False,
                      charging_float_mode=True, disable_temperature_sensors=False,
                      display_always_on=False, special_charger=False, port_is_rs485=True,
                      gps_heartbeat=False, disable_pcl_module=False, timed_stored_data=True,
                      smart_sleep=False),
        sleep=dict(smart_sleep_time_hours=24))


def validate(rows, live):
    assert len(rows) == 14 * 144 + 1
    for i, r in enumerate(rows):
        assert i == 0 or r['t'] - rows[i-1]['t'] == 600
        assert r['cell_mask'] == 65535 and r['cell_count'] == len(r['cells']) == 16
        assert r['temp_mask'] == 7 and len(r['temps']) == 6
        assert abs(r['v'] - sum(r['cells']) / 1000) < .001
        assert 16 <= r['s'] <= 99
        assert all(2800 < v < 3650 for v in r['cells'])
        assert 150 < r['temps'][1] < 450
        if i:
            expected_delta = (r['a'] + rows[i-1]['a']) / 2 / 6 / CAPACITY_AH * 100
            assert abs((r['s'] - rows[i-1]['s']) - expected_delta) < 1.2
    assert live['voltage_v'] == rows[-1]['v'] and live['current_a'] == rows[-1]['a']
    day = rows[-145:]
    assert min(r['a'] for r in day) < -25 and max(r['a'] for r in day) > 25
    return dict(records=len(rows), soc_range=[min(r['s'] for r in rows), max(r['s'] for r in rows)],
                last_day_soc=[min(r['s'] for r in day), max(r['s'] for r in day)],
                last_day_power_w=[round(min(r['v']*r['a'] for r in day)), round(max(r['v']*r['a'] for r in day))])

if __name__ == '__main__':
    import json
    print(json.dumps(validate(*generate()), indent=2))
