#include "jk_bms_write_codec.h"

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void expect_frame(const char *key, double value,
                         const uint8_t expected[JK_BMS_WRITE_FRAME_LENGTH]) {
    jk_bms_write_command_t command;
    assert(jk_bms_write_prepare(key, value, &command) == JK_BMS_WRITE_OK);
    assert(command.spec != NULL);
    assert(memcmp(command.frame, expected, JK_BMS_WRITE_FRAME_LENGTH) == 0);
}

static void test_golden_vectors(void) {
    /* Independently calculated additive checksum; bytes 10..18 are zero. */
    const uint8_t ovp[] = {
        0xAA, 0x55, 0x90, 0xEB, 0x04, 0x04, 0x42, 0x0E, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xD2
    };
    expect_frame("cell_voltage.ovp_v", 3.650, ovp);

    /* JK02_32S discharge UTP is 0x3A (not 0x1E), signed int8. */
    const uint8_t under_temp[] = {
        0xAA, 0x55, 0x90, 0xEB, 0x3A, 0x01, 0xF6, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xAB
    };
    expect_frame("temperature.discharge_utp_c", -10, under_temp);

    const uint8_t sleep_hours[] = {
        0xAA, 0x55, 0x90, 0xEB, 0x39, 0x01, 0x17, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xCB
    };
    expect_frame("sleep.smart_sleep_time_hours", 23, sleep_hours);

    const uint8_t discharging[] = {
        0xAA, 0x55, 0x90, 0xEB, 0x1E, 0x04, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9D
    };
    expect_frame("switches.discharge", 1, discharging);
}

static void test_range_and_precision(void) {
    jk_bms_write_command_t command;

    assert(jk_bms_write_prepare(NULL, 2.0, &command) == JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("battery.device_address", 1, &command) ==
           JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("cell_voltage.smart_sleep_v", 3.2, &command) ==
           JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("current_limits.discharge_precharge_s", 1, &command) ==
           JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("switches.port_is_rs485", 1, &command) ==
           JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("switches.gps_heartbeat", 1, &command) ==
           JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("switches.special_charger", 1, &command) ==
           JK_BMS_WRITE_UNSUPPORTED);
    assert(jk_bms_write_prepare("cell_voltage.ovp_v", NAN, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("cell_voltage.ovp_v", INFINITY, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("cell_voltage.ovp_v", -1.0, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("cell_voltage.ovp_v", 3.6505, &command) ==
           JK_BMS_WRITE_NOT_REPRESENTABLE);
    assert(jk_bms_write_prepare("switches.charge", 2.0, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("switches.charge", 0.1, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("temperature.discharge_utp_c", -129, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("temperature.heating_start_c", 128, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("sleep.smart_sleep_time_hours", 256, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("battery.cell_count", 1.5, &command) ==
           JK_BMS_WRITE_NOT_REPRESENTABLE);
    assert(jk_bms_write_prepare("battery.cell_count", 0, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("battery.cell_count", 33, &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("battery.cell_count", 16, &command) ==
           JK_BMS_WRITE_OK);
    assert(jk_bms_write_prepare("cell_voltage.ovp_v", 1, NULL) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("current_limits.charge_ocp_delay_s", 4294967296., &command) ==
           JK_BMS_WRITE_INVALID);
    assert(jk_bms_write_prepare("current_limits.charge_ocp_delay_s", 4294967295., &command) ==
           JK_BMS_WRITE_OK);
    assert(command.frame[6] == 0xFF && command.frame[9] == 0xFF);
    assert(jk_bms_write_prepare("temperature.charge_utp_c", -12.3, &command) ==
           JK_BMS_WRITE_OK);
    assert(command.frame[6] == 0x85 && command.frame[7] == 0xFF);
}

static void test_fresh_readback(void) {
    jk_bms_write_command_t command;
    jk_bms_settings_t snapshot = {0};

    assert(jk_bms_write_prepare("cell_voltage.ovp_v", 3.65, &command) ==
           JK_BMS_WRITE_OK);
    snapshot.valid = true;
    snapshot.received_count = 4;
    snapshot.cell_ovp_v = 3.65f;
    assert(jk_bms_write_compare(&command, &snapshot, 4) ==
           JK_BMS_WRITE_READBACK_UNAVAILABLE);
    assert(jk_bms_write_compare(&command, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_MATCH);
    snapshot.cell_ovp_v = 3.64f;
    assert(jk_bms_write_compare(&command, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_MISMATCH);
    snapshot.valid = false;
    assert(jk_bms_write_compare(&command, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_UNAVAILABLE);

    assert(jk_bms_write_prepare("temperature.discharge_utp_c", -10, &command) ==
           JK_BMS_WRITE_OK);
    snapshot.valid = true;
    snapshot.discharge_utp_c = -10;
    assert(jk_bms_write_compare(&command, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_MATCH);

    assert(jk_bms_write_prepare("switches.charge", 1, &command) ==
           JK_BMS_WRITE_OK);
    snapshot.charge_switch = true;
    assert(jk_bms_write_compare(&command, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_MATCH);
    snapshot.charge_switch = false;
    assert(jk_bms_write_compare(&command, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_MISMATCH);
    assert(jk_bms_write_compare(NULL, &snapshot, 3) ==
           JK_BMS_WRITE_READBACK_UNAVAILABLE);

    /* Preflight compare-and-swap: matching 200 A must be accepted; changing
     * to 195 A only refuses a stale baseline if BMS has actually changed.
     */
    snapshot.valid = true;
    snapshot.received_count = 9;
    snapshot.max_discharge_current_a = 200.0f;
    assert(jk_bms_write_prepare("current_limits.max_discharge_a", 200.0,
                                &command) == JK_BMS_WRITE_OK);
    assert(jk_bms_write_compare(&command, &snapshot, 0) ==
           JK_BMS_WRITE_READBACK_MATCH);
    snapshot.max_discharge_current_a = 195.0f;
    assert(jk_bms_write_compare(&command, &snapshot, 0) ==
           JK_BMS_WRITE_READBACK_MISMATCH);

    /* Production parser uses raw U32 milliamps * 0.001f, not a floating
     * literal. At 200 A this decodes to 200.000015... on the ESP32; the
     * previous hard 0.01 mA tolerance falsely returned UNAVAILABLE/412. */
    const uint32_t values[] = {80000u, 85000u, 91000u, 195000u, 199000u,
                               200000u, 201000u, 250000u, 500000u};
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {
        const uint32_t raw = values[i];
        const double amps = (double) raw / 1000.0;
        snapshot.max_discharge_current_a = raw * 0.001f;
        assert(jk_bms_write_prepare("current_limits.max_discharge_a", amps,
                                    &command) == JK_BMS_WRITE_OK);
        assert(jk_bms_write_compare(&command, &snapshot, 0) ==
               JK_BMS_WRITE_READBACK_MATCH);
        if (raw >= 1000u) {
            assert(jk_bms_write_prepare("current_limits.max_discharge_a",
                                        amps - 0.001, &command) == JK_BMS_WRITE_OK);
            assert(jk_bms_write_compare(&command, &snapshot, 0) ==
                   JK_BMS_WRITE_READBACK_MISMATCH);
        }
    }
    /* A genuinely different BMS value must still fail CAS. */
    snapshot.max_discharge_current_a = 199000u * 0.001f;
    assert(jk_bms_write_prepare("current_limits.max_discharge_a", 200.0,
                                &command) == JK_BMS_WRITE_OK);
    assert(jk_bms_write_compare(&command, &snapshot, 0) ==
           JK_BMS_WRITE_READBACK_MISMATCH);
    /* When float no longer distinguishes neighbouring raw milliamps,
     * reject as unavailable instead of approving an ambiguous write. */
    snapshot.max_discharge_current_a = 3000000u * 0.001f;
    assert(jk_bms_write_prepare("current_limits.max_discharge_a", 3000.0,
                                &command) == JK_BMS_WRITE_OK);
    assert(jk_bms_write_compare(&command, &snapshot, 0) ==
           JK_BMS_WRITE_READBACK_UNAVAILABLE);
}

static void test_allowlist(void) {
    size_t count;
    const jk_bms_write_spec_t *specs = jk_bms_write_specs(&count);
    assert(specs != NULL && count >= 40 && count <= 53);
    for (size_t i = 0; i < count; ++i) {
        assert(specs[i].api_key != NULL);
        assert(specs[i].register_id != 0);
        assert(specs[i].scale == 1 || specs[i].scale == 10 || specs[i].scale == 1000);
        assert(specs[i].payload_length == 1 || specs[i].payload_length == 4);
        assert(jk_bms_write_find(specs[i].api_key) == &specs[i]);
        for (size_t j = i + 1; j < count; ++j) {
            assert(strcmp(specs[i].api_key, specs[j].api_key) != 0);
        }
    }
    assert(jk_bms_write_find("temperature.discharge_utp_c")->register_id == 0x3A);
    assert(jk_bms_write_find("temperature.discharge_utpr_c")->register_id == 0x3B);
    assert(jk_bms_write_find("switches.discharge")->register_id == 0x1E);
    assert(jk_bms_write_find("switches.balancer")->register_id == 0x1F);
}

int main(void) {
    test_golden_vectors();
    test_range_and_precision();
    test_fresh_readback();
    test_allowlist();
    puts("JK BMS write codec: OK");
    return 0;
}
