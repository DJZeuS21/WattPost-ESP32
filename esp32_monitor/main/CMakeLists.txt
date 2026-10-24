set(WEB_VERSION_FILE "${CMAKE_CURRENT_LIST_DIR}/../VERSION")
file(STRINGS "${WEB_VERSION_FILE}" WATTPOST_WEB_VERSION LIMIT_COUNT 1)
string(STRIP "${WATTPOST_WEB_VERSION}" WATTPOST_WEB_VERSION)

set(WEB_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/../web")
set(WEB_BUILD_DIR "${CMAKE_BINARY_DIR}/generated_web")
set(WEB_PACKAGER "${CMAKE_CURRENT_LIST_DIR}/../tools/package_web.py")

file(GLOB_RECURSE WEB_SOURCE_FILES "${WEB_SOURCE_DIR}/*")
if(NOT CMAKE_SCRIPT_MODE_FILE)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${WEB_PACKAGER}" ${WEB_SOURCE_FILES})
endif()

file(REMOVE_RECURSE "${WEB_BUILD_DIR}")
execute_process(
    COMMAND "${PYTHON}" "${WEB_PACKAGER}"
            --source "${WEB_SOURCE_DIR}"
            --output "${WEB_BUILD_DIR}"
            --version "${WATTPOST_WEB_VERSION}"
    RESULT_VARIABLE WEB_PACK_RESULT
    ERROR_VARIABLE WEB_PACK_ERROR
)
if(NOT WEB_PACK_RESULT EQUAL 0)
    message(FATAL_ERROR "Failed to package web assets: ${WEB_PACK_ERROR}")
endif()

file(GLOB_RECURSE WEB_EMBED_FILES "${WEB_BUILD_DIR}/*.gz")

idf_component_register(
    SRCS "main.c" "ble_candidate_policy.c" "captive_dns.c" "captive_dns_protocol.c" "cloud_transport.c" "cloud_transport_format.c" "cloud_history_format.c" "cloud_transport_policy.c" "device_config.c" "device_identity.c" "device_identity_random.c" "setup_access.c" "local_api_security.c" "provisioning_policy.c" "remote_ota.c" "history.c" "history_query.c" "jk_bms_ble.c" "jk_bms_parser.c" "json_writer.c" "settings_json.c" "temperature_profiles.c"
    INCLUDE_DIRS "." "${CMAKE_BINARY_DIR}" "${WEB_BUILD_DIR}"

    EMBED_FILES ${WEB_EMBED_FILES}
    EMBED_TXTFILES "wattpost_firmware_public_key.pub"
    REQUIRES app_update bootloader_support bt espcoredump esp_driver_gpio esp_event esp_http_client esp_http_server esp_hw_support esp_netif esp_timer esp_wifi json lwip mbedtls mdns nvs_flash
)
