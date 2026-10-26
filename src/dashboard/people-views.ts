import { cell, esc, fmtInt, headers, table, timeTag } from "./html.js";
import type { PersonActivity } from "./queries.js";
import { ICON, badge, dash, empty, section, statList } from "./parts.js";
import { layout } from "./layout.js";

// --- /people: who the agent pages, who may approve, who may talk to it ---
// The lists are SLACK_ONCALL_USERS / SLACK_APPROVER_USERS / SLACK_ALLOWED_USERS, read from this
// process's config — the same arrays app/remediation.ts and slackUserAllowed() enforce, so the page
// cannot describe a policy the agent is not running. Read-only: changing a list is a deploy.

/** What users.info told us about one id. `deleted` = the Slack account is deactivated. */
export interface SlackProfile {
  name: string;
  handle?: string;
  title?: string;
  deleted?: boolean;
}

export interface PeopleView {
  oncall: readonly string[];
  approvers: readonly string[];
  allowed: readonly string[];
  /** Approve/reject clicks per user, last 30 days (remediations.approved_by). */
  activity: readonly PersonActivity[];
  profiles: ReadonlyMap<string, SlackProfile>;
  /** The first users.info error (e.g. `missing_scope`); null when every lookup answered. */
  profilesError: string | null;
}

/** The approver list the click handler uses: SLACK_APPROVER_USERS, or on-call when it is empty. */
const effectiveApprovers = (v: PeopleView): readonly string[] => (v.approvers.length > 0 ? v.approvers : v.oncall);

/** Who slackUserAllowed() admits: everyone when the allowlist is empty, else allowed ∪ on-call ∪ approvers. */
const mentioners = (v: PeopleView): string[] | null =>
  v.allowed.length === 0 ? null : [...new Set([...v.allowed, ...v.oncall, ...v.approvers])];

const people = (n: number): string => `${fmtInt(n)} ${n === 1 ? "person" : "people"}`;

export interface PolicyRow {
  permission: string;
  who: string;
  /** The env var that closes it. */
  fix: string;
  open: boolean;
}

/** One row per thing a Slack user can do to — or be asked by — the agent, and whether it is restricted. */
export function accessPolicy(v: PeopleView): PolicyRow[] {
  const approvers = effectiveApprovers(v);
  const m = mentioners(v);
  return [
    {
      permission: "Approve or reject a remediation card",
      who:
        approvers.length === 0
          ? "Anyone in the channel"
          : `${people(approvers.length)}${v.approvers.length === 0 ? ", from the on-call list" : ""}`,
      fix: "SLACK_APPROVER_USERS",
      open: approvers.length === 0,
    },
    {
      permission: "Mention the agent and ✅-learn",
      who: m === null ? "Anyone in a channel the bot is in" : `${people(m.length)}, on-call and approvers included`,
      fix: "SLACK_ALLOWED_USERS",
      open: m === null,
    },
    {
      permission: "Paged on a low-confidence RCA",
      who: v.oncall.length === 0 ? "Nobody" : people(v.oncall.length),
      fix: "SLACK_ONCALL_USERS",
      open: v.oncall.length === 0,
    },
  ];
}

/** Two letters for the avatar: first and last word of the name; "?" when Slack gave no name. */
export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]!];
  const last = words.length > 1 ? [...words[words.length - 1]!][0] : first[1];
  return ((first[0] ?? "") + (last ?? "")).toUpperCase();
}

function memberCell(id: string, p: SlackProfile | undefined): string {
  const second = [p?.title, p?.handle ? `@${p.handle}` : undefined].filter((s): s is string => !!s).map(esc);
  return (
    `<div class="person">` +
    `<span class="avatar" aria-hidden="true">${esc(initials(p?.name))}</span>` +
    `<span class="person-text">` +
    // No profile: the id IS the name line, so it is not repeated under itself.
    (p
      ? `<strong>${esc(p.name)}</strong>` +
        `<span class="meta">${[...second, `<code translate="no">${esc(id)}</code>`].join(" · ")}</span>`
      : `<strong><code translate="no">${esc(id)}</code></strong><span class="meta">No Slack profile</span>`) +
    `</span></div>`
  );
}

function activityCell(a: PersonActivity | undefined): string {
  const total = a ? a.approved + a.rejected : 0;
  if (!a || total === 0) return `<span class="meta">No decisions</span>`;
  // The bar is the approve share; the rest of the track is rejections. Neither is bad news — a
  // reject is the gate working — so the track stays neutral rather than red.
  const share = Math.round((a.approved / total) * 100);
  return (
    `<span class="ratio" style="--a:${share}" role="img" aria-label="${share}% approved"><span></span></span>` +
    `<span class="activity"><span class="num">${fmtInt(a.approved)}</span> approved · <span class="num">${fmtInt(a.rejected)}</span> rejected</span>`
  );
}

export function peoplePage(v: PeopleView, now: Date, openIncidents?: number): string {
  const approvers = effectiveApprovers(v);
  const viaOncall = v.approvers.length === 0;
  const m = mentioners(v);
  const byUser = new Map(v.activity.map((a) => [a.user, a]));
  const listed = new Set([...v.oncall, ...approvers, ...v.allowed]);
  const nameOf = (id: string) => v.profiles.get(id)?.name ?? id;
  // Listed people first, by name; a decider on no list sinks to the bottom, where it reads as the exception.
  const ids = [...new Set([...listed, ...v.activity.map((a) => a.user)])].sort(
    (a, b) => Number(!listed.has(a)) - Number(!listed.has(b)) || nameOf(a).localeCompare(nameOf(b))
  );
  const approved = v.activity.reduce((n, a) => n + a.approved, 0);
  const rejected = v.activity.reduce((n, a) => n + a.rejected, 0);

  const shelf = statList([
    {
      icon: ICON.speech,
      label: "On-call",
      value: fmtInt(v.oncall.length),
      sub: v.oncall.length > 0 ? "paged on a low-confidence RCA" : "nobody is paged",
      tone: v.oncall.length > 0 ? undefined : "warning",
    },
    {
      icon: ICON.check,
      label: "Approvers",
      value: approvers.length > 0 ? fmtInt(approvers.length) : "Anyone",
      sub: approvers.length === 0 ? "no approver list is set" : viaOncall ? "the on-call list" : "may approve a card",
      tone: approvers.length > 0 ? undefined : "warning",
    },
    {
      icon: ICON.at,
      label: "Can mention",
      value: m === null ? "Anyone" : fmtInt(m.length),
      sub: m === null ? "in any channel the bot is in" : "allowed, on-call and approvers",
      tone: m === null ? "warning" : undefined,
    },
    {
      icon: ICON.wrench,
      label: "Decisions · 30d",
      value: fmtInt(approved + rejected),
      sub: `${fmtInt(approved)} approved · ${fmtInt(rejected)} rejected`,
    },
  ]);

  const policyRows = accessPolicy(v)
    .map(
      (r) =>
        `<tr role="row"${r.open ? ` data-tone="warning"` : ""}>` +
        cell("Permission", esc(r.permission), "primary") +
        cell(
          "Who",
          esc(r.who) + (r.open ? `<div class="sub">Set <code translate="no">${esc(r.fix)}</code> to restrict it.</div>` : "")
        ) +
        cell("Status", r.open ? badge("open", "warning") : badge("restricted", "ok")) +
        `</tr>`
    )
    .join("");

  const memberRows = ids
    .map((id) => {
      const p = v.profiles.get(id);
      const roles = [
        v.oncall.includes(id) ? badge("on-call", "") : "",
        approvers.includes(id) ? badge(viaOncall ? "approver · via on-call" : "approver", "") : "",
        v.allowed.includes(id) ? badge("allowed", "") : "",
        // Clicked a card but is on no list: approved while the lists were open, or removed since.
        listed.has(id) ? "" : badge("not listed", "warning"),
        // Still on a list, but the Slack account is gone — the list needs a deploy to catch up.
        p?.deleted ? badge("deactivated", "critical") : "",
      ].filter(Boolean);
      const a = byUser.get(id);
      return (
        `<tr role="row">` +
        cell("Member", memberCell(id, p), "primary") +
        cell("Roles", `<div class="roles">${roles.join("")}</div>`) +
        cell("Activity · 30d", activityCell(a)) +
        cell("Last approval", a?.lastApproval ? timeTag(a.lastApproval, now) : dash, "when") +
        `</tr>`
      );
    })
    .join("");

  const members = memberRows
    ? `${section(ICON.people, "Members", `<span class="meta">${people(ids.length)}</span>`)}
     ${v.profilesError ? `<p class="meta">Slack names unavailable (<code>${esc(v.profilesError)}</code>) — showing user ids. The bot needs the <code>users:read</code> scope, and the app reinstalled after adding it.</p>` : ""}
     ${table(headers("Member", "Roles", "Activity · 30d", "Last approval"), memberRows, "stack")}`
    : `${section(ICON.people, "Members")}
     ${empty("No one is configured.", "Set SLACK_ONCALL_USERS, SLACK_APPROVER_USERS and SLACK_ALLOWED_USERS in the release values.", ICON.people)}`;

  return layout(
    "People",
    `<div class="doc">
     <p class="eyebrow">Agent</p>
     <h1>People</h1>
     <p class="meta">Who the agent pages, who may approve its remediation cards, and who may talk to it — read from
       this process's configuration, so a change is a deploy.</p>
     ${shelf}
     ${section(ICON.check, "Access policy")}
     ${table(headers("Permission", "Who", "Status"), policyRows, "stack")}
     ${members}
     </div>`,
    { current: "/people", openIncidents }
  );
}
