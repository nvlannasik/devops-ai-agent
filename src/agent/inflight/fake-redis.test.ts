// A test double for the slice of ioredis the in-flight registry and the thread lock use: SET with
// EX/PX/NX/KEEPTTL, GET, DEL, SCAN … MATCH, MGET, PEXPIRE, and EVAL of the lock's two
// compare-then-act scripts. Expiry runs on the real clock. Named *.test.ts so the build leaves it
// out; it holds no tests of its own.
export function fakeRedis() {
  const data = new Map<string, string>();
  const expires = new Map<string, number>(); // key → epoch ms
  const live = (k: string) => {
    const at = expires.get(k);
    if (at !== undefined && Date.now() >= at) { data.delete(k); expires.delete(k); }
    return data.has(k);
  };
  const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const api = {
    ttlOf: (k: string) => (expires.has(k) ? Math.round((expires.get(k)! - Date.now()) / 1000) : undefined),
    async set(k: string, v: string, ...args: (string | number)[]) {
      if (args.includes("NX") && live(k)) return null;
      const ex = args.indexOf("EX"), px = args.indexOf("PX");
      if (ex >= 0) expires.set(k, Date.now() + Number(args[ex + 1]) * 1000);
      else if (px >= 0) expires.set(k, Date.now() + Number(args[px + 1]));
      else if (!args.includes("KEEPTTL")) expires.delete(k);
      data.set(k, v);
      return "OK";
    },
    async get(k: string) { return live(k) ? data.get(k)! : null; },
    async del(...ks: string[]) { let n = 0; for (const k of ks) if (live(k)) { data.delete(k); expires.delete(k); n++; } return n; },
    async mget(...ks: string[]) { return ks.map((k) => (live(k) ? data.get(k)! : null)); },
    async pexpire(k: string, ms: number) { if (!live(k)) return 0; expires.set(k, Date.now() + Number(ms)); return 1; },
    async scan(_cursor: string, ...args: (string | number)[]) {
      const m = args.indexOf("MATCH");
      const re = glob(m >= 0 ? String(args[m + 1]) : "*");
      return ["0", [...data.keys()].filter((k) => live(k) && re.test(k))];
    },
    // The thread lock's scripts are "if GET == token then DEL|PEXPIRE". Recognised by what they do.
    async eval(script: string, _numKeys: number, key: string, token: string, ms?: number) {
      if ((await api.get(key)) !== token) return 0;
      return /pexpire/i.test(script) ? api.pexpire(key, Number(ms)) : api.del(key);
    },
  };
  return api;
}
