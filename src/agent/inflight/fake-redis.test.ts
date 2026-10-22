// A test double for the slice of ioredis the in-flight registry uses: SET … EX, GET, DEL, SCAN …
// MATCH, MGET. Named *.test.ts so the build leaves it out; it holds no tests of its own.
export function fakeRedis() {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return {
    ttlOf: (k: string) => ttl.get(k),
    async set(k: string, v: string, ...args: (string | number)[]) {
      const ex = args.indexOf("EX");
      if (ex >= 0) ttl.set(k, Number(args[ex + 1]));
      else if (!args.includes("KEEPTTL")) ttl.delete(k);
      data.set(k, v);
      return "OK";
    },
    async get(k: string) { return data.get(k) ?? null; },
    async del(...ks: string[]) { let n = 0; for (const k of ks) if (data.delete(k)) { ttl.delete(k); n++; } return n; },
    async mget(...ks: string[]) { return ks.map((k) => data.get(k) ?? null); },
    async scan(_cursor: string, ...args: (string | number)[]) {
      const m = args.indexOf("MATCH");
      const re = glob(m >= 0 ? String(args[m + 1]) : "*");
      return ["0", [...data.keys()].filter((k) => re.test(k))];
    },
  };
}
