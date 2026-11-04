"""Tests for devops-vm-agent: the VM runs only its own allowlist, and reports what it did."""
import importlib.util
import json
import pathlib
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("vm_agent", HERE / "devops-vm-agent.py")
vm_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm_agent)


class Stub(BaseHTTPRequestHandler):
    """The central endpoints: answers claims from a queue, records every request."""
    claims = []
    seen = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)) or 0)
        Stub.seen.append((self.path, self.headers.get("authorization"), json.loads(body or b"{}")))
        if self.path == "/vm/actions/claim" and Stub.claims:
            payload = json.dumps(Stub.claims.pop(0)).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


class Runner:
    """Stands in for subprocess.run; records every command."""
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        out = "active\n" if cmd[:2] == ["systemctl", "is-active"] else "line1\nline2\n"
        return type("P", (), {"returncode": 0, "stdout": out, "stderr": ""})()


class AgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.claims, Stub.seen = [], []
        self.runner = Runner()
        cfg = {"name": "vm-a", "url": self.url, "token": "tok-a", "units": ["nginx.service"], "poll_seconds": 10, "ca_file": None}
        self.agent = vm_agent.Agent(cfg, runner=self.runner)

    def test_a_listed_unit_is_restarted_and_reported(self):
        Stub.claims = [{"id": 3, "unit": "nginx.service", "action": "restart"}]
        self.agent.poll_once()
        self.assertEqual(self.runner.calls[0][:3], ["systemctl", "restart", "nginx.service"])
        path, auth, body = Stub.seen[-1]
        self.assertEqual(path, "/vm/actions/3/result")
        self.assertEqual(auth, "Bearer tok-a")
        self.assertEqual((body["status"], body["exitCode"], body["active"]), ("succeeded", 0, "active"))
        self.assertIn("line2", body["journal"])

    def test_an_unlisted_unit_is_refused_and_nothing_runs(self):
        Stub.claims = [{"id": 4, "unit": "sshd.service", "action": "restart"}]
        self.agent.poll_once()
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(Stub.seen[-1][0], "/vm/actions/4/result")
        self.assertEqual(Stub.seen[-1][2]["status"], "refused")

    def test_no_pending_action_does_nothing(self):
        self.agent.poll_once()
        self.assertEqual(self.runner.calls, [])
        self.assertEqual([p for p, _, _ in Stub.seen], ["/vm/actions/claim"])

    def test_heartbeat_sends_the_allowlist(self):
        self.agent.heartbeat()
        self.assertEqual(Stub.seen[-1][0], "/vm/heartbeat")
        self.assertEqual(Stub.seen[-1][2]["units"], ["nginx.service"])

    def test_plain_http_is_warned_about(self):
        with self.assertLogs("devops-vm-agent", level="WARNING") as logs:
            vm_agent.Agent({"name": "vm-a", "url": "http://x", "token": "t", "units": [], "poll_seconds": 10, "ca_file": None}, runner=self.runner)
        self.assertTrue(any("http://" in m for m in logs.output))

    def test_config_parses_units_and_rejects_a_missing_token(self):
        p = HERE / "_test.conf"
        p.write_text("[agent]\nname = vm-a\nurl = https://agent.example/\ntoken = t\nunits = nginx.service orders.service\n")
        try:
            cfg = vm_agent.load_config(p)
            self.assertEqual(cfg["units"], ["nginx.service", "orders.service"])
            self.assertEqual(cfg["poll_seconds"], 10)
            p.write_text("[agent]\nname = vm-a\nurl = https://x/\nunits = a.service\n")
            with self.assertRaises(SystemExit):
                vm_agent.load_config(p)
        finally:
            p.unlink()


if __name__ == "__main__":
    unittest.main()
