import { type McpTools } from "../mcp/types.js";
import { ConversationMemory } from "../memory/index.js";
import { buildStaticSystemPrompt, buildTimeContext } from "../prompts/system.js";
import { assembleRequest, sanitizeContentBlocks } from "../context/index.js";
import { type Budget } from "../context/budget.js";
import { type Skill, type SkillRegistry } from "../skills/index.js";
import { namespacesOf, outOfScope } from "../scope/index.js";
import { flagInjection } from "../injection/index.js";
import { DELEGATE_TOOL, DELEGATE_MARKER, capFanout, childDeadline, hypothesisOf, subThreadId, withDelegateTool } from "../subagent/index.js";
import { historyContent } from "../fabricated-note/index.js";
import { config } from "../../config/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { type LLMClient, type LLMResponse, type ContentBlock } from "../llm/types.js";
import logger from "../../utils/logger/index.js";
import { errDetail } from "../../utils/logger/index.js";
import { TraceRecorder } from "../trace/index.js";
import { LOG_TOOLS, returnedLogLines, memoSawLogLines } from "./log-gap.js";
import { MAX_ITERATIONS, MAX_LOG_FANOUT, TOOL_BUDGET_NOTICE, forcedFinalAnswer, MAX_TRACKED_THREADS, windowOf, memoCovers, toolCallKey, placeholderIn, PLACEHOLDER_REFUSAL, REPEAT_NOTICE, reportProgress, modeTag, evidenceStamp, staleEvidenceNotice, evidenceTexts } from "./control.js";
import { ThreadSkills, selectForThread, decayThreadSkills, resolveSkillNames } from "../skills/thread.js";
import { extractText } from "./control.js";
import { newRunState, addUsage, type InvestigateOptions, type RunCtx, type RunState } from "./run-state.js";
import { finalizeAnswer } from "./finalize.js";
import { settleAnswer } from "./answer-gates.js";

/**
 * What the loop needs from the agent. Every member is read LIVE: initialize() swaps the memory
 * backend, the recorder and the budget after the runner exists (same rule as RemediatorHost).
 */
export interface RunnerHost {
  readonly mcp: McpTools;
  readonly llm: LLMClient;
  readonly memory: ConversationMemory;
  readonly skills: SkillRegistry;
  readonly threadSkills: ThreadSkills;
  trace(): TraceRecorder;
  budget(): Budget;
  /** A delegate goes through this — withTrace + finish per sub-thread — never through run(). */
  investigate(threadId: string, userMessage: string, opts?: InvestigateOptions): Promise<string>;
  recordUsage(threadTs: string | null, response: LLMResponse): void;
}

/**
 * The agentic loop (2026-10-21: out of DevOpsAgent). One run is `run()`: the tool rounds, the
 * gates (answer-gates.ts), delegation, the tool memo, and the thread's playbooks.
 */
export class InvestigationRunner {
  // threadId -> (tool call key -> in-flight or settled result). One entry per INVESTIGATION,
  // not per thread: a later turn must be free to re-fetch, because the cluster moved on.
  private readonly toolMemo = new Map<string, Map<string, { result: Promise<string>; window: number[] }>>();

  constructor(private readonly host: RunnerHost) {}

  async run(threadId: string, userMessage: string, opts: InvestigateOptions = {}): Promise<string> {
    logger.info(`[${threadId}] Investigation started`);
    this.host.trace().begin(threadId, {
      phase: "investigate",
      issue: userMessage,
      opts: {
        mode: opts.mode ?? "alert",
        trigger: opts.trigger ?? null,
        namespace: opts.namespace ?? null,
        maxToolRounds: opts.maxToolRounds !== undefined && Number.isFinite(opts.maxToolRounds) ? opts.maxToolRounds : null,
        maxIterations: opts.maxIterations ?? null,
        depth: opts.depth ?? 0,
      },
      tools: this.host.mcp.getTools(),
    });
    logger.debug(`[${threadId}] Issue: ${truncate(userMessage, 120)}`);
    const investigationStart = Date.now();

    // A fresh memo per investigation — a follow-up an hour later must be allowed to re-query.
    // Capped like threadSkills: a thread that never comes back would otherwise hold its
    // results for the life of the process.
    this.toolMemo.set(threadId, new Map());
    while (this.toolMemo.size > MAX_TRACKED_THREADS) {
      const oldest = this.toolMemo.keys().next().value;
      if (oldest === undefined) break;
      this.toolMemo.delete(oldest);
    }

    // Deterministic tool budget. Prompt-level scope rules alone don't hold: the model
    // kept chasing anomalies into other namespaces on plain data questions. Once the
    // budget is spent, the next LLM call gets NO tools — it must answer with what it has.
    const maxToolRounds = opts.maxToolRounds ?? Infinity;
    const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    const depth = opts.depth ?? 0;
    const mode = opts.mode ?? "alert";

    const isFollowUp = await this.host.memory.hasRca(threadId);

    // Time context on EVERY turn now, not only the first. It used to ride the opening message
    // alone, so eleven turns later the newest statement of what "now" means was 50 minutes old
    // and sat at the far end of the window behind a wall of tool results — the same losing
    // position that made buildMentionMarker() restate itself every turn. Two lines of timestamps
    // per turn is a cheap price for the model knowing what day it is.
    //
    // The staleness line is the other half: the timestamp only helps if something also says when
    // the evidence was read. See staleEvidenceNotice.
    const staleness = staleEvidenceNotice(await this.host.memory.get(threadId));
    const messageToAppend = [
      buildTimeContext(),
      staleness,
      // for follow-up: explicit mode instruction so the LLM doesn't default to RCA format
      isFollowUp
        ? `[FOLLOW-UP — conversation mode, do NOT use RCA format. Out-of-scope requests (code, general questions) are still declined in one line per Scope of Work, even mid-thread.]\n${userMessage}`
        : userMessage,
    ]
      .filter(Boolean)
      .join("\n\n");

    await this.host.memory.append(threadId, { role: "user", content: messageToAppend });
    if (staleness) logger.debug(`[${threadId}] prior evidence is stale — warned the model to re-read`);

    // Matched on the alert text alone, not on userMessage: src/app/index.ts prepends recalled
    // prior incidents, and a previous incident's RCA must not select this one's playbook.
    // A thread outlives a pod: its conversation comes back from Redis, so its playbooks have to
    // as well or the follow-up answers with a different skill set than the turn it follows.
    await this.rehydrateThreadSkills(threadId);
    const decayed = decayThreadSkills(this.host.threadSkills, threadId);
    if (decayed.length > 0) {
      logger.info(`[${threadId}] playbooks aged out before this turn: ${decayed.join(", ")} (re-selected if they still match)`);
    }
    // The mode tag rides the trigger so a skill can declare its own mode condition in
    // frontmatter instead of the loop hardcoding a skill name — `rca-format` is `when:
    // mode:(alert|investigation)`. No playbook regex matches the tag itself; skills/real.test.ts
    // pins that, because a `when` that happened to contain "alert" would load on every run.
    const s = newRunState(selectForThread(this.host.skills, this.host.threadSkills, threadId, `${modeTag(mode)}\n${opts.trigger ?? userMessage}`));
    this.persistThreadSkills(threadId, s.skills);

    // SECURITY: [WRITE] tools never enter the agentic loop — the model must not be able
    // to execute state-changing actions on its own. Write tools are reachable only via
    // the proposal dry-run and the human-approved execution path (direct callTool).
    const tools = withDelegateTool(
      this.host.mcp.getTools().filter((t) => !t.description.startsWith("[WRITE]")),
      config.subagents,
      { depth, maxToolRounds }
    );
    const systemPrompt = buildStaticSystemPrompt();
    // Every exit from this loop goes through here, so the footer is never missing from the
    // paths that matter most — the timeout and the out-of-steps replies are exactly where a
    // reader wants to know how long it ran and on which model.
    //
    // The completion line is emitted HERE rather than where the model stops talking, and that is
    // a fix, not a tidy-up: it used to sit above the log-gap gate, so a run that took the extra
    // round logged "Investigation complete in 28451ms (2 LLM calls)" and then kept going, twice
    // in one thread on 2026-09-15. It also never fired at all on the deadline and out-of-steps
    // exits, which are the two a reader most wants the duration for.
    const done = (text: string): string => finalizeAnswer(ctx, s, this.host.trace(), text);

    // A delegate inherits a deadline instead of taking a fresh one: its whole point is to finish
    // inside the parent's budget, and config.investigationTimeoutMs would hand it the full 300s
    // the parent is already spending.
    const deadline = opts.deadline ?? investigationStart + config.investigationTimeoutMs;
    const ctx: RunCtx = { threadId, mode, depth, maxToolRounds, maxIterations, deadline, startedAt: investigationStart, tools, systemPrompt, opts };

    while (s.iterations < maxIterations) {
      if (Date.now() > deadline) {
        // The budget is the deadline, not the configured timeout: a delegate is given what is
        // left of its parent's, so naming config.investigationTimeoutMs here reported 300s at a
        // sub-thread that never had more than a fraction of it.
        const overBy = deadline - investigationStart;
        // The third ceiling, and it obeys the same rule as the other two now: end in an answer,
        // never an apology. It used to return the apology below immediately, throwing away every
        // tool result the run had gathered — the identical regression the iteration ceiling was
        // added to fix, left in place here because no backend was slow enough to reach it. One
        // that answers in 20-100s reaches it on an ordinary alert, so the evidence at stake is
        // real and this is where it was being discarded.
        //
        // Overrunning the deadline by one tool-free call is already this design's documented
        // behaviour ("~budget + one in-flight call" in MEMORY_BANK), so the answer turn costs
        // nothing that was not already promised. `toolsDisabled` doubles as the guard against
        // taking it twice: on the next pass we are still past the deadline, so a model that
        // spent its answer turn asking for more tools falls through to the apology, which by
        // then is the honest reply.
        const notice = forcedFinalAnswer({ toolRounds: s.toolRounds, maxToolRounds, iterations: s.iterations, maxIterations, depth, outOfTime: true });
        if (notice && !s.toolsDisabled && s.toolRounds > 0) {
          s.toolsDisabled = true;
          await this.host.memory.append(threadId, { role: "user", content: [{ type: "text", text: notice }] });
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${s.iterations} LLM calls ` +
            `and ${s.toolRounds} tool rounds — forcing a final answer from the evidence gathered`
          );
          this.host.trace().gate(threadId, "deadline", "forced");
        } else {
          // Nothing gathered, or the answer turn is already spent. Either way there is no
          // finding to salvage and the apology is the truthful reply.
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${s.iterations} LLM calls ` +
            `(tool rounds: ${s.toolRounds}, answer turn ${s.toolsDisabled ? "already spent" : "not reachable"})`
          );
          this.host.trace().gate(threadId, "deadline", "apology");
          return done("⚠️ Investigation exceeded its time budget. Please review the partial findings above and try a more specific query.");
        }
      }
      s.iterations++;

      const assembled = assembleRequest({
        history: await this.host.memory.get(threadId),
        systemPrompt,
        tools: s.toolsDisabled ? [] : tools,
        skills: s.skills,
        budget: this.host.budget(),
      });
      logger.debug(
        `[${threadId}] LLM call #${s.iterations} (history: ${assembled.messages.length} messages, ` +
        `-${assembled.messagesDropped} over budget, ~${assembled.estimatedTokens} tokens, ` +
        `skills: [${assembled.skillsUsed.join(", ") || "none"}]` +
        (assembled.skillsDropped.length > 0 ? `, dropped: [${assembled.skillsDropped.join(", ")}]` : "") + ")"
      );
      if (assembled.skillsDropped.length > 0) {
        logger.warn(`[${threadId}] context budget dropped skills: ${assembled.skillsDropped.join(", ")}`);
      }
      // The floor: the first and the most recent message are pinned unconditionally, so a single
      // enormous tool result can put the request over the window with nothing left to drop. Say so
      // and send it anyway — a visible 400 from the backend beats inventing a truncation that
      // hides which evidence went missing.
      const available = this.host.budget().contextTokens - this.host.budget().reserveTokens;
      if (assembled.estimatedTokens > available) {
        logger.warn(
          `[${threadId}] context over budget: ~${assembled.estimatedTokens} tokens vs ${available} ` +
          `available — pinned messages alone exceed the window, sending anyway`
        );
      }

      this.host.trace().skills(threadId, assembled.skillsUsed);
      const llmStart = Date.now();
      let response;
      try {
        response = await this.host.llm.chat(assembled.messages, s.toolsDisabled ? [] : tools, assembled.systemPrompt);
        s.lastResponse = response;
      } catch (err) {
        // the LLM call is the one hop that leaves this process; without this line a
        // worker/queue failure surfaced only as a generic Slack error with no context
        logger.error(`[${threadId}] LLM call #${s.iterations} failed after ${Date.now() - llmStart}ms: ${errDetail(err)}`);
        throw err;
      }
      const llmMs = Date.now() - llmStart;

      // what the model actually produced — the missing piece when Slack shows garbage but
      // the logs only say "stop=end_turn"
      logger.debug(
        `[${threadId}] LLM #${s.iterations} content: [${response.content.map((c) => c.type).join(", ") || "empty"}]` +
        (extractText(response.content) ? ` text="${truncate(extractText(response.content), 200)}"` : "")
      );

      if (response.usage) {
        s.totalUsage = addUsage(s.totalUsage, response.usage);
        this.host.recordUsage(threadId, response);
        logger.debug(
          `[${threadId}] LLM #${s.iterations} ${llmMs}ms | ` +
          `in=${response.usage.inputTokens} out=${response.usage.outputTokens} ` +
          `cache_read=${response.usage.cacheReadTokens} cache_write=${response.usage.cacheCreationTokens} ` +
          `stop=${response.stopReason}`
        );
      } else {
        logger.debug(`[${threadId}] LLM responded in ${llmMs}ms, stop_reason: ${response.stopReason}`);
      }

      // Scrubbed of any [system note] the model wrote itself — see historyContent. Only memory: the
      // reply this turn returns goes through done(), which scrubs and logs it for Slack.
      await this.host.memory.append(threadId, { role: "assistant", content: historyContent(response.content).blocks });

      if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
        const answer = await settleAnswer(this.host, ctx, s, response);
        if (answer === null) continue;
        return done(answer);
      }

      if (response.stopReason === "tool_use") await this.toolRound(ctx, s, response);
    }

    // Residual only: `forcedFinalAnswer` spends the second-to-last round disabling tools, so
    // reaching here means the model answered that turn with another tool_use instead of prose.
    // Nothing was posted to the thread, so don't tell the reader to review findings "above".
    logger.warn(`[${threadId}] Investigation hit max iterations (${maxIterations}) — model kept calling tools on its final, tool-free turn`);
    this.host.trace().gate(threadId, "iteration-ceiling", "exhausted");
    return done("⚠️ Investigation ran out of steps before the model wrote a conclusion. Nothing was lost — re-run it, or ask about one specific symptom to narrow the search.");
  }

  /**
   * Runs each delegated hypothesis as its own investigation, in parallel, and returns one
   * tool_result per call — including for the ones that could not run, because an unanswered
   * tool_use is a 400 from Anthropic rather than a smaller request.
   *
   * The delegates go through `investigate()` rather than `runInvestigation()` so each gets its
   * own trace context: the sub-thread id is prefixed with the parent's, so grepping the Slack
   * thread id still finds every child across the agent and llm-worker logs, and grepping the
   * sub id isolates one of them. They do NOT take a semaphore slot — that lives in app/index.ts
   * around the entry points, and a child waiting on a permit its own parent is holding is a
   * deadlock at MAX_CONCURRENT_INVESTIGATIONS.
   */
  private async runDelegates(
    threadId: string,
    calls: ContentBlock[],
    parentDeadline: number
  ): Promise<{ results: ContentBlock[]; sawLogLines: boolean }> {
    const cutoff = childDeadline(parentDeadline);
    const block = (id: string | undefined, content: string): ContentBlock =>
      ({ type: "tool_result" as const, tool_use_id: id, content });
    let sawLogLines = false; // any delegate's log call returned lines — see memoSawLogLines

    const results = await Promise.all(
      calls.map(async (call, i) => {
        const hypothesis = hypothesisOf(call);
        if (!hypothesis) {
          return block(call.id, "Error: delegate_investigation needs a non-empty `hypothesis` — state the claim to test.");
        }
        if (Date.now() >= cutoff) {
          logger.warn(`[${threadId}] delegate refused — less than the reserve left before the investigation deadline`);
          this.host.trace().gate(threadId, "delegate", "refused");
          return block(
            call.id,
            "Error: not enough time left in this investigation's budget to delegate. Answer with the evidence already gathered."
          );
        }

        const sub = subThreadId(threadId, i + 1);
        const start = Date.now();
        logger.info(`[${threadId}] → delegate ${sub}: ${truncate(hypothesis, 160)}`);
        try {
          const findings = await this.host.investigate(sub, `${DELEGATE_MARKER}\n${hypothesis}`, {
            maxToolRounds: config.subagents.toolRounds,
            maxIterations: config.subagents.maxIterations,
            deadline: cutoff,
            depth: 1,
            // Playbooks are selected from the hypothesis, not from the parent's alert text: the
            // delegate is investigating one failure mode, and that is the text describing it.
            trigger: hypothesis,
          });
          logger.info(`[${threadId}] ← delegate ${sub} ok (${Date.now() - start}ms, ${findings.length} chars)`);
          // Read before `finally` drops the memo.
          if (await memoSawLogLines(this.toolMemo.get(sub))) sawLogLines = true;
          return block(call.id, `[delegate: ${hypothesis}]\n${findings}`);
        } catch (e) {
          logger.error(`[${threadId}] ← delegate ${sub} failed (${Date.now() - start}ms): ${errDetail(e)}`);
          return block(call.id, `Error: this delegated investigation failed (${errDetail(e)}). Continue without it and say in your answer that this hypothesis was not tested.`);
        } finally {
          // A sub-thread is scratch space: nothing reads it after the findings come back, and
          // leaving it behind leaks one Redis key (24h TTL) and one threadSkills entry per
          // delegate against a Map capped at MAX_TRACKED_THREADS.
          await this.host.memory.clear(sub).catch((e) => logger.warn(`[${threadId}] delegate ${sub} memory cleanup failed: ${errDetail(e)}`));
          this.host.threadSkills.delete(sub);
          this.toolMemo.delete(sub);
        }
      })
    );
    return { results, sawLogLines };
  }

  private async executeToolCalls(threadId: string, content: ContentBlock[], namespace?: string): Promise<ContentBlock[]> {
    const toolUses = content.filter((c) => c.type === "tool_use");
    const defs = this.host.mcp.getTools();
    // The MCP server's own tool names, which is what makes `run k8s_scale` distinguishable from
    // any other sentence in a log line — see agent/injection/.
    const toolNames = defs.map((t) => t.name);

    // This is the trust boundary: every string below was written by something in the cluster,
    // not by the operator. It is the ONLY place raw tool output enters the conversation (a
    // delegate's results come back through its own call to this method), so the injection frame
    // goes on here and nowhere else — refusals and delegate summaries are our own text.
    const guard = (raw: string, name: string | undefined): string => {
      const { content: framed, hits } = flagInjection(raw, toolNames);
      if (hits.length > 0) {
        logger.warn(`[${threadId}] possible prompt injection in ${name} result [${hits.join(", ")}] — framed as data, not blocked`);
        this.host.trace().gate(threadId, "injection", "framed", name ?? "", { hits });
      }
      return framed;
    };

    // run all tool calls in parallel — k8s/prometheus/loki calls are independent
    return Promise.all(
      toolUses.map(async (toolUse) => {
        const { id, name, input } = toolUse;
        // second layer of the write-tool exclusion (first: filtered from the tools list)
        const def = defs.find((t) => t.name === name);
        if (def?.description.startsWith("[WRITE]")) {
          logger.warn(`[${threadId}] blocked direct write-tool call: ${name}`);
          this.host.trace().gate(threadId, "write-blocked", "refused", name ?? "");
          return {
            type: "tool_result" as const,
            tool_use_id: id,
            content: "Error: write tools require the human approval flow and cannot be called during an investigation.",
          };
        }
        const placeholder = placeholderIn(input);
        if (placeholder) {
          logger.warn(`[${threadId}] refused ${name}: placeholder ${placeholder} in its input`);
          this.host.trace().gate(threadId, "placeholder", "refused", `${name}: ${placeholder}`);
          return { type: "tool_result" as const, tool_use_id: id, content: PLACEHOLDER_REFUSAL(placeholder, namespace) };
        }
        // Repeat suppression. The memo holds the PROMISE, not the settled value, so two
        // identical calls in the same parallel round collapse onto one request as well.
        // Only successes stay memoised — a failure that is retried may genuinely succeed,
        // and pinning it would turn one transient error into a dead tool for the rest of
        // the investigation.
        const memo = this.toolMemo.get(threadId);
        const key = toolCallKey(name, input);
        const asked = windowOf(input);
        const cached = memo?.get(key);
        if (cached && memoCovers(cached.window, asked)) {
          try {
            const result = await cached.result;
            logger.info(`[${threadId}] ⟲ tool: ${name} repeat call — served from this investigation's memo (${result.length} chars), not re-run`);
            this.host.trace().gate(threadId, "repeat-call", "memo", name ?? "");
            return { type: "tool_result" as const, tool_use_id: id, content: guard(REPEAT_NOTICE + result, name) };
          } catch {
            memo?.delete(key); // it failed; let this call have its own attempt
          }
        }

        const start = Date.now();
        logger.info(`[${threadId}] → tool: ${name} input: ${truncate(JSON.stringify(input))}`);
        const pending = this.host.mcp.callTool(name!, input as Record<string, unknown>);
        memo?.set(key, { result: pending, window: asked });
        try {
          const result = await pending;
          logger.info(`[${threadId}] ← tool: ${name} ok (${Date.now() - start}ms, ${result.length} chars)`);
          return { type: "tool_result" as const, tool_use_id: id, content: guard(result, name) };
        } catch (err) {
          memo?.delete(key);
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[${threadId}] ← tool: ${name} failed (${Date.now() - start}ms): ${errMsg}`);
          // Guarded too: an upstream error quotes what it choked on, so an annotation or a
          // container name can reach us inside a message we only appear to have written.
          return { type: "tool_result" as const, tool_use_id: id, content: guard(`Error: ${errMsg}`, name) };
        }
      })
    );
  }

  /** One round of tool calls: the guards, the delegates, the calls, and the playbooks the evidence names. */
  private async toolRound(ctx: RunCtx, s: RunState, response: LLMResponse): Promise<void> {
    if (s.toolsDisabled) {
      // model emitted tool_use even though no tools were offered — keep the
      // tool_use/tool_result pairing intact with synthesized errors and loop again
      const synth = response.content
        .filter((c) => c.type === "tool_use")
        .map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: "Error: tool budget exhausted — answer with the data already gathered.",
        }));
      await this.host.memory.append(ctx.threadId, { role: "user", content: synth });
      return;
    }

    // Conversation-mode guards. Prompt rules alone did not stop the model from
    // (a) chasing anomalies into other namespaces and (b) dumping logs of every pod
    // matching a generic name — both are enforced here deterministically.
    let executable = response.content.filter((c) => c.type === "tool_use");
    const refusals: ContentBlock[] = [];

    // Delegation is intercepted here, before the conversation-mode guards below. The MCP
    // server has no such tool, and a delegate must not reach namespacesOf(): it carries no
    // namespace, so a first round of nothing but delegates would lock the scope to the empty
    // set — which is the case that disables the lock for the rest of the run.
    let delegateResults: ContentBlock[] = [];
    const delegateCalls = executable.filter((t) => t.name === DELEGATE_TOOL);
    if (delegateCalls.length > 0) {
      executable = executable.filter((t) => t.name !== DELEGATE_TOOL);
      const { run, refusals: overflow } = capFanout(delegateCalls, config.subagents.maxFanout);
      if (overflow.length > 0) {
        logger.info(
          `[${ctx.threadId}] ${delegateCalls.length} delegates requested, fan-out cap is ` +
          `${config.subagents.maxFanout} — ${overflow.length} refused`
        );
      }
      const delegated = await this.runDelegates(ctx.threadId, run, ctx.deadline);
      delegateResults = [...delegated.results, ...overflow];
      if (delegated.sawLogLines) s.sawLogLines = true;
    }

    if (ctx.maxToolRounds !== Infinity) {
      // Namespace scope lock: the first tool round defines the question's namespaces.
      if (s.scopeNamespaces === null) {
        s.scopeNamespaces = namespacesOf(executable);
      } else {
        const drift = outOfScope(executable, s.scopeNamespaces);
        if (drift.length > 0) {
          const scopeList = [...s.scopeNamespaces].join(", ");
          logger.info(`[${ctx.threadId}] blocked ${drift.length} out-of-scope tool call(s) — question scope is [${scopeList}]`);
          this.host.trace().gate(ctx.threadId, "scope-lock", "refused", scopeList, { count: drift.length });
          refusals.push(
            ...drift.map((t) => ({
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: `Error: out of scope — this question is about namespace(s) ${scopeList}. Answer with the data you already have; if something outside that scope looks relevant, mention it in one line and ask the user before expanding.`,
            }))
          );
          executable = executable.filter((t) => !drift.includes(t));
        }
      }

      // Log fan-out guard: a generic name matching many pods → ask, don't dump.
      const logCalls = executable.filter((t) => t.name === "k8s_get_pod_logs");
      const logPods = new Set(logCalls.map((t) => (t.input as Record<string, unknown> | undefined)?.pod_name));
      if (logPods.size > MAX_LOG_FANOUT) {
        logger.info(`[${ctx.threadId}] log fan-out to ${logPods.size} pods blocked — steering to a confirmation question`);
        this.host.trace().gate(ctx.threadId, "log-fanout", "refused", "", { pods: logPods.size });
        refusals.push(
          ...logCalls.map((t) => ({
            type: "tool_result" as const,
            tool_use_id: t.id,
            content: `Error: logs for ${logPods.size} different pods requested at once — ambiguous. List the matching pods (grouped by workload) and ask the user which one they want. Do not fetch all logs.`,
          }))
        );
        executable = executable.filter((t) => t.name !== "k8s_get_pod_logs");
      }
    }

    // Reported here rather than after the LLM call: this is the last point at which we
    // know what the round will really do — the scope lock, the fan-out guard and the
    // delegate split have all had their say, so the names below are the ones that run.
    reportProgress(ctx.opts.onProgress, s.toolRounds, [...executable, ...delegateCalls], (err) =>
      logger.debug(`[${ctx.threadId}] progress callback threw, ignored: ${errDetail(err)}`)
    );

    s.totalToolCalls += executable.length;
    const executed = executable.length > 0 ? await this.executeToolCalls(ctx.threadId, executable, ctx.opts.namespace) : [];
    if (!s.sawLogLines) {
      const logIds = new Set(executable.filter((t) => LOG_TOOLS.has(t.name ?? "")).map((t) => t.id));
      s.sawLogLines = executed.some(
        (r) => r.type === "tool_result" && logIds.has(r.tool_use_id) && returnedLogLines(String(r.content ?? ""))
      );
    }
    const trimmedResults = sanitizeContentBlocks([...executed, ...delegateResults, ...refusals]);
    // Appended, never unshifted: Anthropic requires every tool_result block to come first in
    // its user message, and a text block ahead of them is a 400.
    if (executed.length > 0) trimmedResults.push({ type: "text", text: evidenceStamp() });

    s.toolRounds++;
    const notice = forcedFinalAnswer({ toolRounds: s.toolRounds, maxToolRounds: ctx.maxToolRounds, iterations: s.iterations, maxIterations: ctx.maxIterations, depth: ctx.depth });
    if (notice) {
      s.toolsDisabled = true;
      trimmedResults.push({ type: "text", text: notice });
      logger.info(
        notice === TOOL_BUDGET_NOTICE
          ? `[${ctx.threadId}] tool budget (${ctx.maxToolRounds} rounds) reached — forcing final answer`
          : `[${ctx.threadId}] iteration ceiling (${ctx.maxIterations}) reached after ${s.toolRounds} tool rounds — forcing final answer`
      );
      this.host.trace().gate(ctx.threadId, notice === TOOL_BUDGET_NOTICE ? "tool-budget" : "iteration-ceiling", "forced");
    }

    await this.host.memory.append(ctx.threadId, { role: "user", content: trimmedResults });

    // Playbooks are picked from the alert text, and a generic alert name says nothing about
    // which failure mode it is: "KubernetesPodNotHealthy" fires for an OOMKill, a failed
    // probe and an unpullable image alike, so none of their playbooks match and the model
    // investigates with the output format alone. The evidence is what names the failure —
    // the events say `ImagePullBackOff` — so match against that too, one result at a time
    // (each gets its own trigger window rather than sharing one truncated concatenation).
    // selectForThread keeps what is already loaded, so this only ever adds.
    for (const text of evidenceTexts(trimmedResults)) {
      const before = s.skills.length;
      s.skills = selectForThread(this.host.skills, this.host.threadSkills, ctx.threadId, text);
      const added = s.skills.slice(before).map((s) => s.name);
      if (added.length > 0) {
        this.persistThreadSkills(ctx.threadId, s.skills);
        logger.info(`[${ctx.threadId}] playbook matched from tool evidence, not the alert text: ${added.join(", ")}`);
      }
    }
  }

  /**
   * Rebuilds this thread's accumulated playbooks from durable memory when this process has never
   * seen the thread — after a restart, a rollout, or on another replica. Names are resolved
   * against the live registry, so a skill deleted from `prompts/skills/` since simply does not
   * come back rather than resurrecting as a dangling name.
   */
  private async rehydrateThreadSkills(threadId: string): Promise<void> {
    if (this.host.threadSkills.has(threadId)) return; // this process already owns the thread's set
    const names = await this.host.memory.getSkills(threadId).catch((err) => {
      logger.warn(`[${threadId}] could not read stored playbooks — reselecting: ${errDetail(err)}`);
      return [] as string[];
    });
    const known = resolveSkillNames(this.host.skills, names);
    if (known.length === 0) return;
    this.host.threadSkills.set(threadId, known);
    logger.info(`[${threadId}] playbooks restored from memory: ${known.map((s) => s.name).join(", ")}`);
  }

  // Fire-and-forget, like recordUsage: losing a playbook name costs the next turn a reselection,
  // and blocking an investigation on a cache write would be the worse trade.
  private persistThreadSkills(threadId: string, skills: readonly Skill[]): void {
    void this.host.memory
      .setSkills(threadId, skills.map((s) => s.name))
      .catch((err) => logger.warn(`[${threadId}] could not store playbooks: ${errDetail(err)}`));
  }
}
