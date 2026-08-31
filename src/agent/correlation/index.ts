// Alert correlation — one Alertmanager webhook is ONE group (its `group_by`, typically
// alertname+namespace), so every alert in the payload shares a root cause. Investigate the
// group ONCE instead of spawning N threads / N investigations / N remediation cards for N
// crashlooping pods. We deliberately do NOT correlate across different alertnames/webhooks
// here (that heuristic risks merging unrelated incidents — YAGNI until it's shown to hurt).

export interface AlertItem {
  status?: "firing" | "resolved";
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
}

const nonEmpty = (o?: Record<string, string>): Record<string, string> | undefined =>
  o && Object.keys(o).length > 0 ? o : undefined;

/** Labels shared (same key AND value) by every alert in the set — the group's identity. */
export function commonLabels(alerts: AlertItem[]): Record<string, string> {
  if (alerts.length === 0) return {};
  const [first, ...rest] = alerts;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(first.labels)) {
    if (rest.every((a) => a.labels[k] === v)) out[k] = v;
  }
  return out;
}

/**
 * Annotations every alert in the set agrees on, word for word. The mirror of commonLabels, and
 * it exists because Alertmanager's own `commonAnnotations` is empty the moment a rule templates
 * the subject into its text — "error rate for service checkout-gateway" and "...for service
 * storefront" are different strings, so a 4-alert group across two services arrives with none.
 */
export function commonAnnotationsOf(alerts: AlertItem[]): Record<string, string> {
  const [first, ...rest] = alerts;
  if (!first?.annotations) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(first.annotations)) {
    if (rest.every((a) => a.annotations?.[k] === v)) out[k] = v;
  }
  return out;
}

/**
 * What the alerts are ABOUT, deduplicated: the first of these labels that any alert carries
 * decides, and the same key is then read across the whole group so the list cannot mix kinds.
 * `job` is deliberately absent — it is the scrape job (`kubernetes-pods`), identical across a
 * group and therefore never a subject.
 */
const SUBJECT_LABELS = ["service", "deployment", "workload", "app"] as const;

export function distinctSubjects(alerts: AlertItem[]): { key: string; values: string[] } | null {
  for (const key of SUBJECT_LABELS) {
    const values = [...new Set(alerts.map((a) => a.labels[key]).filter(Boolean) as string[])].sort();
    if (values.length > 0) return { key, values };
  }
  return null;
}

/**
 * The label set to key the group on (dedup / incident store / remediation). Prefer what
 * Alertmanager already computed (`commonLabels`, then the `group_by` `groupLabels`), and
 * fall back to the intersection so non-Alertmanager senders still work. Guaranteed non-empty
 * when there's at least one alert — an empty key would collide unrelated groups in Redis.
 */
export function groupIdentity(
  payload: { commonLabels?: Record<string, string>; groupLabels?: Record<string, string> },
  alerts: AlertItem[]
): Record<string, string> {
  return (
    nonEmpty(payload.commonLabels) ??
    nonEmpty(payload.groupLabels) ??
    nonEmpty(commonLabels(alerts)) ??
    alerts[0]?.labels ??
    {}
  );
}

const SEVERITY_EMOJI: Record<string, string> = { critical: "🔴", warning: "🟡", info: "🔵" };

// Common rule packs (awesome-prometheus-alerts and friends) template the raw value and a Go
// map dump onto the end of the description: "\n  VALUE = 2\n  LABELS = map[pod:x uid:y ...]".
// The map is unreadable in Slack and duplicates the fields rendered below, so cut it here —
// the labels come back structured on the *Labels:* line, which the LLM reads just as well.
const ANNOTATION_NOISE = /\n\s*(VALUE|LABELS)\s*=[\s\S]*$/;
const clean = (s: string): string => s.replace(ANNOTATION_NOISE, "").trim();

// Labels that already have their own field above, plus `uid` — a Kubernetes object UID is
// unqueryable for a human and for the model, and it changes on every pod restart.
const OWN_FIELD_LABELS = new Set(["alertname", "severity", "namespace", "pod", "container", "uid"]);

/**
 * Slack text for a firing group. For a single alert this reads like the old per-alert
 * message; for N>1 it lists the affected pods (capped) so the investigation sees every
 * target without spawning a thread per pod.
 */
export function buildGroupAlertText(
  groupLabels: Record<string, string>,
  alerts: AlertItem[],
  commonAnnotations?: Record<string, string>
): string {
  const alertName = groupLabels.alertname ?? alerts[0]?.labels.alertname ?? "Unknown";
  const severity = groupLabels.severity ?? alerts[0]?.labels.severity ?? "unknown";
  const emoji = SEVERITY_EMOJI[severity] ?? "⚪";
  const n = alerts.length;
  // NOT `alerts[0].annotations` as a fallback: for a group whose rule templates the subject into
  // its text that silently presents ONE member's description as the group's, which is how a
  // 4-alert group across two services rendered as a checkout-gateway-only incident — to the
  // on-call and to the agent, since this text is also the investigation's input. For n === 1 the
  // intersection IS alerts[0]'s annotations, so a single alert renders exactly as before.
  const shownAnn = nonEmpty(commonAnnotations) ?? nonEmpty(commonAnnotationsOf(alerts)) ?? {};
  // A group whose members disagree still has something worth printing; it just may not speak for
  // the group, and the label has to say so.
  const ann = nonEmpty(shownAnn) ? shownAnn : (alerts[0]?.annotations ?? {});
  const annSpeaksForGroup = nonEmpty(shownAnn) !== undefined || n === 1;
  const annSuffix = annSpeaksForGroup ? "" : ` (1 of ${n})`;

  const lines: string[] = [
    `:alert: *${alertName}*${n > 1 ? ` — ${n} alerts` : ""}`,
    `*Severity:* ${emoji} \`${severity}\``,
  ];
  if (ann.summary) lines.push(`*Summary${annSuffix}:* ${clean(ann.summary)}`);
  if (ann.description) lines.push(`*Description${annSuffix}:* ${clean(ann.description)}`);

  const namespace = groupLabels.namespace ?? alerts[0]?.labels.namespace;
  if (namespace) lines.push(`*Namespace:* \`${namespace}\``);

  // The scope line the annotations above may not carry. Only when the group really spans more
  // than one: for a single subject the summary already names it.
  const subjects = distinctSubjects(alerts);
  if (subjects && subjects.values.length > 1) {
    const label = subjects.key.charAt(0).toUpperCase() + subjects.key.slice(1);
    lines.push(`*${label}s (${subjects.values.length}):* ${subjects.values.map((v) => `\`${v}\``).join(", ")}`);
  }

  // Distinct pods, not one entry per alert. A rule that fires per (pod, status) produces two
  // alerts for one pod, and the count printed here was the alert count — "4 affected pods" for
  // two, which is the wrong number to hand someone at 3am.
  const pods = [...new Set(alerts.map((a) => a.labels.pod).filter(Boolean) as string[])];
  if (n === 1 && pods.length === 1) {
    lines.push(`*Pod:* \`${pods[0]}\``);
  } else if (pods.length > 0) {
    const shown = pods.slice(0, 10).map((p) => `\`${p}\``).join(", ");
    const more = pods.length > 10 ? ` +${pods.length - 10} more` : "";
    lines.push(`*Affected pods (${pods.length}):* ${shown}${more}`);
  }

  // Group-wide labels only. For an OOMKill the container is the single most important field
  // and today it exists only inside the description prose; but a group spanning two different
  // containers has no one container to name, and commonLabels has already dropped the ones
  // that differ. groupLabels wins where Alertmanager computed it.
  const shared = { ...commonLabels(alerts), ...groupLabels };
  if (shared.container) lines.push(`*Container:* \`${shared.container}\``);

  // Number.isFinite drops a malformed startsAt — otherwise NaN reaches new Date().toISOString()
  // and THROWS, which in handleAlert would drop the alert AND leave it dedup-suppressed for 12h.
  const starts = alerts.map((a) => a.startsAt).filter(Boolean).map((s) => new Date(s!).getTime()).filter(Number.isFinite);
  if (starts.length > 0) {
    const earliest = Math.min(...starts);
    lines.push(`*Firing since:* \`${new Date(earliest).toISOString()}\` (unix: \`${Math.floor(earliest / 1000)}\`)`);
  }

  // Whatever the fields above didn't cover — cluster, job, instance, and anything relabeling
  // added. This is what the stripped LABELS map carried, minus the duplication: the model
  // still gets the full label set to query on. Sorted so the same alert always renders the
  // same text regardless of label insertion order.
  const rest = Object.entries(shared)
    .filter(([k, v]) => v && !OWN_FIELD_LABELS.has(k))
    .sort(([a], [b]) => a.localeCompare(b));
  if (rest.length > 0) lines.push(`*Labels:* ${rest.map(([k, v]) => `\`${k}=${v}\``).join(" ")}`);

  return lines.join("\n");
}
