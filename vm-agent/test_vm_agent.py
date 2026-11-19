"""Tests for devops-vm-agent: the VM runs only its own allowlist, and reports what it did."""
import importlib.util
import json
import pathlib
import tempfile
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
    agents = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)) or 0)
        Stub.seen.append((self.path, self.headers.get("authorization"), json.loads(body or b"{}")))
        Stub.agents.append(self.headers.get("user-agent"))
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
        Stub.claims, Stub.seen, Stub.agents = [], [], []
        self.runner = Runner()
        cfg = {"name": "vm-a", "url": self.url, "token": "tok-a", "units": ["nginx.service"], "poll_seconds": 10, "ca_file": None}
        self.agent = vm_agent.Agent(cfg, runner=self.runner, snap=lambda: {"memory": {"totalBytes": 1}})

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
        self.assertEqual(Stub.seen[-1][2]["snapshot"], {"memory": {"totalBytes": 1}})

    def test_heartbeat_names_its_cluster_and_node_only_when_set(self):
        self.agent.heartbeat()
        self.assertNotIn("cluster", Stub.seen[-1][2])
        self.agent.cfg = {**self.agent.cfg, "cluster": "stg", "node": "worker1"}
        self.agent.heartbeat()
        self.assertEqual((Stub.seen[-1][2]["cluster"], Stub.seen[-1][2]["node"]), ("stg", "worker1"))

    def test_config_rejects_a_bad_cluster_name(self):
        with tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False) as f:
            f.write("[agent]\nname = a\nurl = http://x\ntoken = t\ncluster = Bad Name\n")
        with self.assertRaises(SystemExit):
            vm_agent.load_config(f.name)

    def test_requests_name_the_agent_not_python_urllib(self):
        # Cloudflare blocks the default Python-urllib User-Agent with a 403 (error 1010).
        self.agent.heartbeat()
        self.agent.poll_once()
        self.assertEqual(set(Stub.agents), {f"devops-vm-agent/{vm_agent.VERSION}"})

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


class SnapshotTest(unittest.TestCase):
    """snapshot() over a fake /proc and cgroup tree."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.proc, self.cg = root / "proc", root / "cgroup"

        def w(path, text):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

        w(self.proc / "meminfo", "MemTotal: 2000 kB\nMemFree: 100 kB\nMemAvailable: 200 kB\nCached: 300 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\nAnonPages: 1500 kB\n")
        w(self.proc / "loadavg", "1.50 1.20 0.90 2/300 999\n")
        w(self.proc / "uptime", "4242.5 100.0\n")
        procs = {
            "10": ("etcd", "330000", "0::/system.slice/etcd.service"),
            "11": ("kube-apiserver", "700000", "0::/kubepods.slice/kubepods-burstable.slice/x/cri-containerd-1.scope"),
            "12": ("kubelet", "75000", "0::/system.slice/kubelet.service"),
            "13": ("sshd", "8000", "0::/user.slice/user-1000.slice/session-3.scope"),
        }
        for pid, (name, rss, cg) in procs.items():
            w(self.proc / pid / "status", f"Name:\t{name}\nVmRSS:\t{rss} kB\n")
            w(self.proc / pid / "cgroup", cg + "\n")
        w(self.proc / "2" / "status", "Name:\tkthreadd\n")  # kernel thread: no VmRSS
        w(self.proc / "2" / "cgroup", "0::/\n")
        w(self.cg / "system.slice" / "etcd.service" / "memory.current", "349495296\n")
        w(self.cg / "system.slice" / "kubelet.service" / "memory.current", "80000000\n")
        w(self.cg / "system.slice" / "-.mount" / "memory.current", "1\n")
        w(self.cg / "kubepods.slice" / "memory.current", "900000000\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_memory_processes_units_and_pods(self):
        s = vm_agent.snapshot(proc=str(self.proc), cgroup=str(self.cg))
        self.assertEqual(s["memory"]["totalBytes"], 2000 * 1024)
        self.assertEqual(s["memory"]["availableBytes"], 200 * 1024)
        self.assertEqual(s["load"], [1.5, 1.2, 0.9])
        self.assertEqual(s["uptimeSeconds"], 4242)
        self.assertEqual([p["name"] for p in s["processes"]], ["kube-apiserver", "etcd", "kubelet", "sshd"])
        self.assertEqual([p["unit"] for p in s["processes"]], ["kubepods", "etcd.service", "kubelet.service", "session-3.scope"])
        self.assertEqual(s["processes"][1]["rssBytes"], 330000 * 1024)
        self.assertEqual(s["processCount"], 4)
        self.assertEqual(s["units"], [{"unit": "etcd.service", "memoryBytes": 349495296}, {"unit": "kubelet.service", "memoryBytes": 80000000}])
        self.assertEqual(s["kubepodsMemoryBytes"], 900000000)
        self.assertIn("rootDisk", s)

    def test_never_sends_a_command_line(self):
        (self.proc / "10" / "cmdline").write_text("etcd\0--client-cert-auth\0--peer-key-file=/etc/ssl/etcd/key.pem")
        self.assertNotIn("key.pem", json.dumps(vm_agent.snapshot(proc=str(self.proc), cgroup=str(self.cg))))

    def test_a_missing_tree_leaves_sections_out_instead_of_failing(self):
        s = vm_agent.snapshot(proc=str(self.proc) + "-none", cgroup=str(self.cg) + "-none")
        for key in ("memory", "processes", "units", "kubepodsMemoryBytes"):
            self.assertNotIn(key, s)
