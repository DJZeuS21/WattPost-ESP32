import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "STAGE1_API_CONTRACT.json"


class Stage1ApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        cls.endpoints = cls.contract["endpoints"]

    def test_endpoint_identity_and_method_security(self):
        identities = set()
        for endpoint in self.endpoints:
            identity = (endpoint["method"], endpoint["path"])
            self.assertNotIn(identity, identities, identity)
            identities.add(identity)

            if endpoint["method"] == "POST":
                self.assertEqual(endpoint["security"], "local_mutation")
            else:
                self.assertEqual(endpoint["method"], "GET")
                self.assertIn(endpoint["security"], {"local_read", "request_token"})

    def test_mutation_security_has_browser_integrity_guards(self):
        requirements = set(
            self.contract["security_classes"]["local_mutation"]["requirements"]
        )
        self.assertTrue(
            {
                "allowed_host",
                "origin_matches_host",
                "content_type_application_json",
                "request_token_header",
                "no_cors",
                "cache_no_store",
            }.issubset(requirements)
        )
        self.assertEqual(
            self.contract["security_classes"]["local_mutation"][
                "request_token_header"
            ],
            "X-WattPost-Request-Token",
        )
        self.assertEqual(self.contract["transport"]["cors"], "disabled")

    def test_request_token_is_ephemeral_and_not_user_auth(self):
        token = self.contract["request_token"]
        self.assertGreaterEqual(token["entropy_bits"], 128)
        self.assertEqual(token["storage"], "ram_only")
        self.assertEqual(
            token["purpose"], "browser_request_integrity_not_user_authentication"
        )
        self.assertIn("boot", token["rotate_on"])

    def test_credentials_only_appear_in_wifi_configure_request_body(self):
        credential_endpoints = [
            endpoint
            for endpoint in self.endpoints
            if endpoint.get("credential_request_fields")
        ]
        self.assertEqual(len(credential_endpoints), 1)
        endpoint = credential_endpoints[0]
        self.assertEqual(endpoint["id"], "wifi_configure")
        self.assertEqual(endpoint["credential_request_fields"], ["password"])
        self.assertIn("password", endpoint["request_body_fields"])
        self.assertNotIn("?", endpoint["path"])

        forbidden = set(self.contract["forbidden_response_fields"])
        self.assertIn("password", forbidden)
        self.assertIn("wifi_password", forbidden)
        self.assertIn("ota_token", forbidden)
        self.assertIn("raw_config_blob", forbidden)

    def test_bms_normal_flow_does_not_expose_or_accept_full_mac(self):
        select = next(e for e in self.endpoints if e["id"] == "bms_select")
        self.assertIn("scan_generation", select["request_body_fields"])
        self.assertIn("candidate_id", select["request_body_fields"])
        joined = " ".join(select["request_body_fields"]).lower()
        self.assertNotIn("mac", joined)
        self.assertIn("full_bms_mac", self.contract["forbidden_response_fields"])

    def test_async_mutations_return_operation_contract(self):
        for endpoint in self.endpoints:
            if endpoint["method"] != "POST" or not endpoint.get("async"):
                continue
            self.assertEqual(endpoint["response"], "operation", endpoint["id"])

        operation = self.contract["operation"]
        self.assertEqual(
            operation["state"], ["idle", "running", "success", "error"]
        )
        self.assertTrue(
            {"scanning", "validating", "connecting", "saving"}.issubset(
                set(operation["phase"])
            )
        )
        self.assertEqual(
            operation["fields"],
            ["generation", "state", "phase", "error_code"],
        )

    def test_explicit_actions_have_stable_confirmation_values(self):
        expected = {
            "wifi_reset": "reset_wifi",
            "bms_forget": "forget_bms",
            "system_reboot": "reboot",
            "factory_reset": "factory_reset",
        }
        for endpoint_id, confirmation in expected.items():
            endpoint = next(e for e in self.endpoints if e["id"] == endpoint_id)
            self.assertEqual(endpoint["confirmation_value"], confirmation)
            self.assertEqual(endpoint["method"], "POST")
            self.assertEqual(endpoint["security"], "local_mutation")

        factory_reset = next(
            e for e in self.endpoints if e["id"] == "factory_reset"
        )
        self.assertTrue(factory_reset["destructive"])

    def test_legacy_temperature_mutation_is_brought_under_same_gate(self):
        endpoint = next(
            e for e in self.endpoints if e["id"] == "temperature_config_legacy"
        )
        self.assertTrue(endpoint["legacy"])
        self.assertEqual(endpoint["path"], "/api/config/temperature")
        self.assertEqual(endpoint["security"], "local_mutation")

    def test_http_error_codes_use_supported_contract_range(self):
        errors = self.contract["errors"]
        allowed = {400, 403, 404, 409, 413, 500, 503}
        self.assertTrue(set(errors.values()).issubset(allowed))
        self.assertEqual(errors["forbidden_origin"], 403)
        self.assertEqual(errors["request_token_invalid"], 403)
        self.assertEqual(errors["storage_error"], 500)

    def test_setup_state_distinguishes_config_error_from_first_setup(self):
        setup_states = self.contract["device_status_enums"]["setup_state"]
        self.assertEqual(
            setup_states,
            ["wifi_required", "bms_required", "configured", "config_error"],
        )

    def test_stage1_contract_contains_no_cloud_mutation_paths(self):
        paths = [endpoint["path"] for endpoint in self.endpoints]
        self.assertFalse(any("/cloud" in path for path in paths))
        self.assertFalse(any("/remote" in path for path in paths))


if __name__ == "__main__":
    unittest.main()
