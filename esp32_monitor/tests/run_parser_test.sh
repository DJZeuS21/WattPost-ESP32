#!/usr/bin/env sh
set -eu
python3 -m unittest discover -s tests
test_binary="$(mktemp)"
recovery_binary="$(mktemp)"
boot_button_binary="$(mktemp)"
mdns_binary="$(mktemp)"
history_binary="$(mktemp)"
storage_binary="$(mktemp)"
temp_res_binary="$(mktemp)"
json_binary="$(mktemp)"
nvs_binary="$(mktemp)"
config_binary="$(mktemp)"
identity_binary="$(mktemp)"
cloud_policy_binary="$(mktemp)"
cloud_format_binary="$(mktemp)"
cloud_history_binary="$(mktemp)"
settings_json_binary="$(mktemp)"
wifi_policy_binary="$(mktemp)"
bms_policy_binary="$(mktemp)"
internet_policy_binary="$(mktemp)"
setup_access_binary="$(mktemp)"
provision_policy_binary="$(mktemp)"
security_binary="$(mktemp)"
captive_dns_binary="$(mktemp)"
ble_candidate_binary="$(mktemp)"
query_binary="$(mktemp)"
trap 'rm -f "$test_binary" "$recovery_binary" "$boot_button_binary" "$mdns_binary" "$history_binary" "$storage_binary" "$temp_res_binary" "$json_binary" "$nvs_binary" "$config_binary" "$identity_binary" "$cloud_policy_binary" "$cloud_format_binary" "$cloud_history_binary" "$settings_json_binary" "$wifi_policy_binary" "$bms_policy_binary" "$internet_policy_binary" "$setup_access_binary" "$provision_policy_binary" "$security_binary" "$captive_dns_binary" "$ble_candidate_binary" "$query_binary"' EXIT
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_jk_bms_parser.c main/jk_bms_parser.c -o "$test_binary"
"$test_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_recovery_policy.c -o "$recovery_binary"
"$recovery_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_boot_button_policy.c -o "$boot_button_binary"
"$boot_button_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_mdns_policy.c -o "$mdns_binary"
"$mdns_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_history_average.c main/temperature_profiles.c -o "$history_binary"
"$history_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_history_storage.c main/temperature_profiles.c -o "$storage_binary"
"$storage_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_temperature_resolver.c main/temperature_profiles.c main/jk_bms_parser.c -o "$temp_res_binary"
"$temp_res_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_json_writer.c main/json_writer.c -o "$json_binary"
"$json_binary"
cc -std=c11 -Wall -Wextra -Werror -DESP_PLATFORM -I tests/mock_esp -I main \
  tests/test_temperature_nvs.c main/temperature_profiles.c -o "$nvs_binary"
"$nvs_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_device_config.c main/device_config.c -o "$config_binary"
"$config_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_device_identity.c main/device_identity.c -o "$identity_binary"
"$identity_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_cloud_transport_policy.c main/cloud_transport_policy.c -o "$cloud_policy_binary"
"$cloud_policy_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_cloud_transport_format.c main/cloud_transport_format.c -o "$cloud_format_binary"
"$cloud_format_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_cloud_history_format.c main/cloud_history_format.c -o "$cloud_history_binary"
"$cloud_history_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_settings_json.c main/settings_json.c main/json_writer.c -o "$settings_json_binary"
"$settings_json_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_wifi_runtime_policy.c -o "$wifi_policy_binary"
"$wifi_policy_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_bms_runtime_policy.c -o "$bms_policy_binary"
"$bms_policy_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_internet_reachability_policy.c -o "$internet_policy_binary"
"$internet_policy_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_setup_access.c main/setup_access.c -o "$setup_access_binary"
"$setup_access_binary"
cc -std=c11 -Wall -Wextra -Werror -I tests/mock_esp -I main \
  tests/test_provisioning_policy.c main/provisioning_policy.c -o "$provision_policy_binary"
"$provision_policy_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_local_api_security.c main/local_api_security.c -o "$security_binary"
"$security_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_captive_dns_protocol.c main/captive_dns_protocol.c -o "$captive_dns_binary"
"$captive_dns_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_ble_candidate_policy.c main/ble_candidate_policy.c -o "$ble_candidate_binary"
"$ble_candidate_binary"
cc -std=c11 -Wall -Wextra -Werror -I main \
  tests/test_history_query.c main/history_query.c -o "$query_binary"
"$query_binary"
