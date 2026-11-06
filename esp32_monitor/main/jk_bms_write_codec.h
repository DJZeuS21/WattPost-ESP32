#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "jk_bms_parser.h"

/*
 * Offline JK02_32S write-command codec. Nothing in this module sends BLE
 * commands or authorizes HTTP/Cloud writes. Only the explicit allowlist can
 * be encoded. The local HTTP layer validates request source, the BLE model,
 * expected_before and connection epoch before queuing one write.
 */
#define JK_BMS_WRITE_FRAME_LENGTH 20u

typedef enum {
    JK_BMS_WRITE_UNSIGNED,
    JK_BMS_WRITE_SIGNED,
    JK_BMS_WRITE_BOOLEAN,
} jk_bms_write_wire_t;

typedef enum {
    JK_BMS_WRITE_READ_FLOAT,
    JK_BMS_WRITE_READ_U32,
    JK_BMS_WRITE_READ_U8,
    JK_BMS_WRITE_READ_I8,
    JK_BMS_WRITE_READ_BOOL,
} jk_bms_write_read_kind_t;

typedef struct {
    const char *api_key;
    uint8_t register_id;
    uint8_t payload_length;
    jk_bms_write_wire_t wire_type;
    jk_bms_write_read_kind_t read_kind;
    uint16_t scale;
    size_t settings_offset;
} jk_bms_write_spec_t;

typedef struct {
    const jk_bms_write_spec_t *spec;
    uint8_t frame[JK_BMS_WRITE_FRAME_LENGTH];
    uint32_t raw_value;
} jk_bms_write_command_t;

typedef enum {
    JK_BMS_WRITE_OK = 0,
    JK_BMS_WRITE_UNSUPPORTED,
    JK_BMS_WRITE_INVALID,
    JK_BMS_WRITE_NOT_REPRESENTABLE,
} jk_bms_write_status_t;

typedef enum {
    JK_BMS_WRITE_READBACK_UNAVAILABLE = 0,
    JK_BMS_WRITE_READBACK_MATCH,
    JK_BMS_WRITE_READBACK_MISMATCH,
} jk_bms_write_readback_t;

const jk_bms_write_spec_t *jk_bms_write_specs(size_t *count);
const jk_bms_write_spec_t *jk_bms_write_find(const char *api_key);

/* Input is in the public /api/settings unit (V/A/°C/s/h/bool as 0 or 1).
 * Only exact on-wire multiples are accepted: never round away user input.
 * Numeric storage bounds are NOT the BMS's model-specific safety limits.
 */
jk_bms_write_status_t jk_bms_write_prepare(const char *api_key,
                                             double value,
                                             jk_bms_write_command_t *command);

/*
 * A CRC-valid, freshly decoded settings frame is the only positive readback.
 * The caller must also ensure it belongs to the same BLE connection/target;
 * received_count on its own cannot establish device identity.
 */
jk_bms_write_readback_t jk_bms_write_compare(
    const jk_bms_write_command_t *command,
    const jk_bms_settings_t *settings,
    uint32_t previous_received_count);
