# Dashboard Authentication

**Status:** implemented (2026-08-05). Supersedes §3.1 ("no auth") of
`docs/superpowers/specs/2026-08-03-dashboard-design.md`.

## Why this changed

The dashboard shipped with no authentication and one compensating control: the port is not
routed by the Ingress. That was defensible while the port was reachable only by a
`kubectl port-forward`, but it made every later decision worse than it needed to be:

- `/topology` enumerates the agent's configuration. Under "anyone who reaches the port sees
  everything", the allowlist in `buildTopology()` is the only thing between a reader and the
  shape of the estate.
- The interactive topology (pan/zoom) needs client-side JavaScript. Relaxing
  `default-src 'none'` on an unauthenticated port is a different proposition from relaxing it
  behind a session.
- "Not routed" is a property of a YAML file in another repository that nothing tests. A single
  well-meant Ingress rule turns the incident history into a public page, silently.

Auth does not replace the network boundary. **Both locks stay.** The password is what makes an
accidental Ingress rule survivable; it is not a licence to add one.

## What was rejected

**OIDC at the ingress (oauth2-proxy).** The right answer for a dashboard with real users, and
still the migration path. It needs an IdP, a client registration, and a redirect URI — none of
which is visible from this repository, and none of which the agent can validate at boot. Adding
it now would put the dashboard's availability behind configuration nobody in this repo can test.

**Per-user accounts.** Every page here shows the same thing to everyone, so identity would be
state to store and rotate for no question it could answer. Who approved what is already recorded
in Slack, where the approvals happen. If this dashboard ever grows a mutating action, that
reasoning expires with it and this section should be revisited.

**Server-side session store.** A Map of session ids dies with the pod: every rolling update
would sign every operator out, and rolling updates happen during incidents, which is when this
page is open. Redis is available but adding a hard dependency on it for a statistics page
contradicts "the dashboard may not stop the pod".

## The design

One shared password (`DASHBOARD_PASSWORD`, from a Kubernetes Secret via `secretKeyRef`), a
login form, and a **signed** session cookie.

### The token

```
v1.<expiry-ms>.<base64url HMAC-SHA256 over "v1.<expiry-ms>">
```

The HMAC key is `crypto.scryptSync(password, KEY_SALT, 32)` with a fixed, non-secret salt.

- **Derived, not random.** A random per-process key would invalidate every session on restart
  and on every other replica. Deriving from the password makes the key a pure function of
  configuration: identical on every pod, stable across restarts.
- **scrypt, not a bare HMAC of the password.** Two thirds of the token is public, so its
  signature is an offline oracle for the key that produced it. A memory-hard KDF puts each
  guess at ~100ms instead of microseconds. Derived once per password and memoised.
- **The expiry is inside the signed payload**, so an edited expiry does not verify. 12-hour TTL:
  longer than an incident, shorter than a working week.
- **Rotation is revocation.** Changing `DASHBOARD_PASSWORD` changes the key and invalidates
  every token in circulation. Bumping the `v1` prefix does the same without a password change.

Comparisons (`checkPassword`, signature verification) digest both sides to SHA-256 first and
then use `timingSafeEqual`: that throws on a length mismatch, and guarding it with a length
check would leak the expected length through the fast path.

### Cookie

`dash_session=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` and `Secure` unless
`DASHBOARD_COOKIE_SECURE=false`.

- `HttpOnly` is what keeps the session out of reach of script — the precondition for relaxing
  the CSP for an interactive map later.
- `SameSite=Strict` rather than `Lax`: nothing here is meant to be linked to from elsewhere,
  and Strict is the variant that also covers top-level GET navigation.
- `Secure` defaults on and is opt-out because the failure is silent: a Secure cookie sent over
  plain HTTP is dropped without a word, and the symptom — a login page that reappears forever —
  points nowhere near the cause. Browsers treat `localhost` as a secure context, so a
  port-forward needs no change; only a plain-HTTP hostname does.

### Request handling

Order in `handle()`, and why each step sits where it does:

1. **Parse the request-target.** A request this server cannot parse has no path to authenticate.
2. **Method gate** (405 + `Allow`). Before auth on purpose: a stranger's `POST /incidents` and an
   operator's get the same answer, and neither learns anything. Only `/login` (GET, POST) and
   `/logout` (POST) accept anything but GET — both act on the session, not on data, so the
   dashboard is still read-only by contract.
3. **`/healthz`** — 200, unauthenticated, ahead of everything below. The probe decides whether
   the pod stays Ready; a dashboard secret must never be able to take the agent out of service.
4. **Password-configured gate** — 503 with an explanation. Fail closed: serving the incident
   history anonymously because a Secret did not make it into the pod is the one outcome worth
   an outage on this port. Only on this port — the listener still never stops the pod.
5. **`/login`** — GET renders the form (or redirects if already signed in), POST verifies.
6. **Session gate** — 303 to `/login?next=<path>` for everything else.
7. **404**, then `/topology`, then the database gate, then the pages. The 404 moved *behind* the
   session gate: an unauthenticated caller no longer learns which paths this server serves.

Login POSTs are capped at 4 KiB (declared `Content-Length` first, running total for chunked
bodies) so an unauthenticated request cannot stream into the process that runs investigations.
Over the cap the request is *paused*, not destroyed — destroying it resets the socket the
response still has to be written onto.

### `next` and open redirects

`next` arrives in a URL anyone can put in front of an operator and ends up in a `Location`
header. `safeNext()` accepts only a path on this origin: it must start with `/`, must not start
with `//` or `/\` (both protocol-relative to a browser — same-origin by string inspection,
another site once resolved), and must contain no control characters (header splitting). Anything
else becomes `/`.

### Throttle

`LoginThrottle`: 10 failures per 5-minute window per key → 429 with `Retry-After`. A correct
password clears the count, so a typo costs nothing. The map is bounded at 1024 keys.

The key is `req.socket.remoteAddress`, which behind a proxy is the proxy — every client then
shares one bucket. That is deliberate: a shared bucket still throttles the attack, and the cost
is that a flood degrades access for everyone until the short window rolls over. The alternative,
trusting `X-Forwarded-For`, is a header anyone can write, which would make the throttle
decorative. If this ever sits behind a trusted proxy, read the client address from a header the
proxy is known to overwrite, and only then.

A failed sign-in logs one warning line with the source address. It is bounded by the throttle,
and it is the only record that anyone is trying the door.

### CSP

```
default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

The first two are unchanged. `form-action` does **not** inherit from `default-src`, so the login
form worked without it — it is there to pin where a password may be posted now that there is a
session to steal. `frame-ancestors` stops the page being framed and clickjacked into a sign-out.

There is no `script-src` in that policy, and its absence is the point: with `default-src 'none'`
and no exemption, a missed `esc()` on a page that renders an RCA is inert. `/topology` is the one
route that adds a `script-src`, and it adds it per response — see below.

## Operations

- `DASHBOARD_PASSWORD` lives in the `devops-agent-secret` Secret and is wired with
  `secretKeyRef`, never inline in a ConfigMap.
- That `secretKeyRef` is **`optional: true`**, unlike every other key in the release. A missing
  key in a required `secretKeyRef` leaves the container in `CreateContainerConfigError` — the
  dashboard would then be stopping the pod, which is the one thing it may never do. Absent key
  means unset means 503, and the agent keeps investigating.
- `config` is read once at boot, so **rotating the Secret needs a pod restart** to take effect.
  Reloader is in the cluster but the agent's annotation watches `devops-ai-agent-external-secret`,
  not `devops-agent-secret` — so today that restart is manual.
- Startup logs which mode it is in: `password required` or
  `DASHBOARD_PASSWORD unset — serving 503 until it is set`.

## What this unblocked, and the rule that still holds

The interactive topology (drag to pan, ctrl/cmd + wheel to zoom) needs client JavaScript, which
needs `script-src`. It shipped under the rule this section set: a **nonce**, never
`'unsafe-inline'`.

- One inline block, in `src/dashboard/topology-script.ts`, carrying a nonce minted per response
  (`randomBytes(16).toString("base64url")` — 22 chars, legal both in the header and in the
  attribute). A nonce reused across responses is a nonce an attacker can read off one page and
  paste into the next.
- **Only `/topology` gets a `script-src` at all.** The header is built by `csp(nonce?)` in
  `server.ts`, and every other route calls it with no argument, so "a missed `esc()` is inert"
  stays literally true on the pages that render LLM output and Alertmanager labels. Topology
  renders only allowlisted config values — a much smaller surface to be wrong about.
- The nonce buys one trusted block; it says nothing about what that block then does.
  `topology-script.test.ts` holds the script to that: no `innerHTML`/`document.write`, no
  `eval`/`new Function`, and nothing that could close its own `<script>` element early.
- The map still works with scripting off. The script-free control — three radios whose
  `:checked` state sets the SVG width — is what the page ships; the script removes it and takes
  over. Nothing in the interactive layer is the only way to read the diagram.

`views.test.ts` was narrowed rather than deleted: it now asserts that the topology page carries
exactly one script and that it is the nonce'd one, that no other page carries any script, and
that no page anywhere has an `onclick=` or a `javascript:` URL.
