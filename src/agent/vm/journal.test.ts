import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, unitName } from "./journal.js";

test("unitName: a unit, or a bare name made one; never an option or a path", () => {
  assert.equal(unitName("kubelet"), "kubelet.service");
  assert.equal(unitName("etcd.service"), "etcd.service");
  assert.equal(unitName("var-lib.mount"), "var-lib.mount");
  assert.equal(unitName("--all"), null);
  assert.equal(unitName("../etc/passwd"), null);
  assert.equal(unitName("a b"), null);
});

test("redactSecrets: the patterns devops-vm-agent applies on the host", () => {
  const raw = [
    'level=info token=abc123 user=bob',
    'Authorization: Bearer abcdefghijklmnop',
    'jwt eyJhbGciOiJIUzI1NiJ9.payloadpayload.signaturesig',
    'db_password: "hunter2"',
    'pull https://robot:s3cr3t@registry.example/v2/',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  ].join("\n");
  const out = redactSecrets(raw);
  for (const leaked of ["abc123", "abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9", "hunter2", "s3cr3t", "MIIE"]) assert.doesNotMatch(out, new RegExp(leaked));
  assert.match(out, /token=\[REDACTED\] user=bob/, "the rest of the line stays");
  assert.match(out, /https:\/\/robot:\[REDACTED\]@registry\.example/);
});
