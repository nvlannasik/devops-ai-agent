// Does an image tag exist? (D3 for the agent's own PRs, 2026-11-24.) A GitOps PR that sets an image
// nobody pushed merges cleanly and fails on the next rollout as ImagePullBackOff — bench A03/A08 are
// that incident. One manifest HEAD through the registry's v2 token challenge answers it before the
// merge: anonymous, so a public image on Docker Hub, GHCR, quay.io or registry.k8s.io is checked and
// a private one is "not checked", never "fine".

export interface ImageRef {
  registry: string;
  repository: string;
  reference: string;
}

/** `nginx`, `nvlannasik/x:1.2`, `ghcr.io/o/r:tag`, `r@sha256:…` → registry, repository, tag or digest. */
export function parseImage(image: string): ImageRef | null {
  const s = image.trim();
  if (!s || /\s/.test(s)) return null;
  const [nameTag, digest] = s.split("@") as [string, string | undefined];
  const slash = nameTag.indexOf("/");
  const first = slash > 0 ? nameTag.slice(0, slash) : "";
  const hasRegistry = !!first && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : "registry-1.docker.io";
  let rest = hasRegistry ? nameTag.slice(slash + 1) : nameTag;
  let tag = "latest";
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest) return null;
  if (registry === "registry-1.docker.io" && !rest.includes("/")) rest = `library/${rest}`;
  return { registry: registry === "docker.io" ? "registry-1.docker.io" : registry, repository: rest, reference: digest ?? tag };
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

export type ImageAnswer = { exists: true } | { exists: false } | { unknown: string };

/** One manifest HEAD, following a Bearer challenge once. 200 exists, 404 does not, anything else unknown. */
export async function imageExists(image: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Promise<ImageAnswer> {
  const ref = parseImage(image);
  if (!ref) return { unknown: "not an image reference" };
  const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let res = await fetchImpl(url, { method: "HEAD", headers: { Accept: ACCEPT }, signal });
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      const p = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      if (!/^bearer/i.test(challenge) || !p.realm) return { unknown: "the registry wants credentials" };
      const q = new URLSearchParams({ service: p.service ?? "", scope: p.scope ?? `repository:${ref.repository}:pull` });
      const tok = (await (await fetchImpl(`${p.realm}?${q}`, { signal })).json()) as { token?: string; access_token?: string };
      const bearer = tok.token ?? tok.access_token;
      if (!bearer) return { unknown: "no anonymous token" };
      res = await fetchImpl(url, { method: "HEAD", headers: { Accept: ACCEPT, Authorization: `Bearer ${bearer}` }, signal });
    }
    if (res.status === 200) return { exists: true };
    if (res.status === 404) return { exists: false };
    // Docker Hub answers 401 for a repository that does not exist AND for a private one: not a verdict.
    return { unknown: `the registry answered ${res.status}` };
  } catch (err) {
    return { unknown: (err instanceof Error ? err.message : String(err)).slice(0, 80) };
  }
}
