import { cell, esc, fmtInt, headers, table, timeTag } from "./html.js";
import type { PersonActivity } from "./queries.js";
import { ICON, badge, dash, empty, section } from "./parts.js";
import { layout } from "./layout.js";

// --- /people: who the agent pages, who may approve, who may talk to it ---
// The lists are SLACK_ONCALL_USERS / SLACK_APPROVER_USERS / SLACK_ALLOWED_USERS, read from this
// process's config — the same arrays app/remediation.ts and slackUserAllowed() enforce, so the page
// cannot describe a policy the agent is not running. Read-only: changing a list is a deploy.

export interface PeopleView {
  oncall: readonly string[];
  approvers: readonly string[];
  allowed: readonly string[];
  /** Approve/reject clicks per user, last 30 days (remediations.approved_by). */
  activity: readonly PersonActivity[];
  names: ReadonlyMap<string, string>;
  /** The first users.info error (e.g. `missing_scope`); null when every lookup answered. */
  namesError: string | null;
}

/** The approver list the click handler uses: SLACK_APPROVER_USERS, or on-call when it is empty. */
const effectiveApprovers = (v: PeopleView): readonly string[] => (v.approvers.length > 0 ? v.approvers : v.oncall);

/** What an open list lets anyone do — each one is only a log line at boot otherwise. */
export function accessWarnings(v: PeopleView): string[] {
  const w: string[] = [];
  if (effectiveApprovers(v).length === 0)
    w.push("Anyone in the channel can approve or reject a remediation card — set SLACK_APPROVER_USERS (or SLACK_ONCALL_USERS).");
  if (v.allowed.length === 0)
    w.push("Anyone in a channel the bot is in can mention the agent and ✅-learn — set SLACK_ALLOWED_USERS.");
  if (v.oncall.length === 0) w.push("Nobody is paged on a low-confidence RCA — SLACK_ONCALL_USERS is empty.");
  return w;
}

export function peoplePage(v: PeopleView, now: Date, openIncidents?: number): string {
  const approvers = effectiveApprovers(v);
  const viaOncall = v.approvers.length === 0;
  const byUser = new Map(v.activity.map((a) => [a.user, a]));
  const ids = [...new Set([...v.oncall, ...approvers, ...v.allowed, ...v.activity.map((a) => a.user)])];
  const rows = ids
    .map((id) => {
      const roles = [
        v.oncall.includes(id) ? badge("on-call", "") : "",
        approvers.includes(id) ? badge(viaOncall ? "approver (via on-call)" : "approver", "") : "",
        v.allowed.includes(id) ? badge("allowed", "") : "",
      ].filter(Boolean);
      const a = byUser.get(id);
      const name = v.names.get(id);
      return (
        `<tr role="row">` +
        cell(
          "Person",
          name ? `${esc(name)} <span class="meta" translate="no">${esc(id)}</span>` : `<code translate="no">${esc(id)}</code>`,
          "primary"
        ) +
        // Clicked a card but is on no list: approved while the lists were open, or removed since.
        cell("Roles", roles.length > 0 ? roles.join(" ") : badge("not listed", "warning")) +
        cell("Approved (30d)", a ? fmtInt(a.approved) : dash, "num") +
        cell("Rejected (30d)", a ? fmtInt(a.rejected) : dash, "num") +
        cell("Last approval", a?.lastApproval ? timeTag(a.lastApproval, now) : dash, "when") +
        `</tr>`
      );
    })
    .join("");
  const warnings = accessWarnings(v);
  const body =
    (warnings.length > 0
      ? `${section(ICON.people, "Open access")}
         ${warnings.map((w) => `<p>${badge("open", "warning")} ${esc(w)}</p>`).join("")}`
      : "") +
    (rows
      ? `${section(ICON.people, "People", '<span class="meta">from config · activity from remediation cards</span>')}
         ${v.namesError ? `<p class="meta">Slack names unavailable (<code>${esc(v.namesError)}</code>) — showing user ids. The bot needs the <code>users:read</code> scope.</p>` : ""}
         ${table(headers("Person", "Roles", ["Approved (30d)", "num"], ["Rejected (30d)", "num"], "Last approval"), rows, "pairs")}`
      : empty("No one is configured.", "Set SLACK_ONCALL_USERS, SLACK_APPROVER_USERS and SLACK_ALLOWED_USERS in the release values.", ICON.people));
  return layout(
    "People",
    `<div class="doc">
     <p class="eyebrow">Agent</p>
     <h1>People</h1>
     <p class="meta">Who the agent pages on a low-confidence RCA (on-call), who may approve or reject a remediation card
       (approver), and who may mention it (allowed). Read from this process's configuration — a change is a deploy.</p>
     ${body}
     </div>`,
    { current: "/people", openIncidents }
  );
}
