/**
 * `[system note]` is the system's voice, and the model is not allowed to borrow it.
 *
 * Measured on bench C10 attempt 2, 2026-09-26. The agent had offered a Service deletion, the user
 * answered "ya", and the whole of the next reply was one line, produced in 3.2s with zero tool
 * calls:
 *
 *     [system note] The action to delete `bench-c10/Service/bench-c10-cache` was approved and
 *     successfully executed.
 *
 * No card had been posted. Nothing had been executed. The Service was still there until the
 * fixture's own cleanup removed it.
 *
 * Only `DevOpsAgent` writes that marker (`memory.append(... "[system note] " + note)`), and
 * `prompts/system.md` tells the model that such entries are remediation lifecycle FACTS — card
 * posted, refused, executed — and that a card exists only if a note says so. So the prompt hands
 * the model a token it is told to trust and never says "you must not write one", and the model
 * used it as output.
 *
 * Two things went wrong at once, and the second is why this is code:
 *
 *   1. In production that sentence IS the Slack reply. `dropCardPromises` does not catch it —
 *      measured, `dropped=0` — because the sentence never mentions a card. A human reads that the
 *      delete they approved succeeded, and nothing happened.
 *   2. It SUPPRESSES the card. The proposal step reads the reply as its evidence, sees an action
 *      already approved and executed, and correctly answers `{"action": null}`. The agent claims it
 *      did the thing and therefore never does it.
 *
 * `prompts/system.md` already says "never claim you executed anything". That rule existed and did
 * not hold, which is the shape this repo keeps meeting: a prompt rule alone has never held on a
 * small model here. This is the backstop under it, not a new policy.
 *
 * NOT folded into `stripTemplateEcho`, though `[system note]` is a bracket of our own vocabulary:
 * that function removes the BRACKET and keeps the line, which here would leave "The action to
 * delete ... was approved and successfully executed." standing as the agent's own sentence — worse
 * than the fabrication, because the tell is gone. The whole line has to go.
 *
 * Deliberately narrow: the marker only. The other half of the same lie ("the deletion completed
 * successfully", no marker) is left alone, because catching it means matching execution vocabulary
 * and an RCA legitimately says things like "the previous rollout completed successfully" about
 * output it READ. `worthProposing` was patched four times for exactly that kind of guessing. The
 * marker case is decidable with certainty, and it is the one that also fools the proposal step,
 * because the marker is what the prompt told the model to believe.
 *
 * ponytail: known ceiling — thread memory keeps the RAW reply (that is how `parseOffer` still finds
 * the `[OFFER]` line `done()` strips), so a fabricated note survives in history and a later turn can
 * read it back as a lifecycle fact. Fixing that means giving history entries provenance, not a wider
 * regex here. Nothing measured yet turns on it; revisit when a multi-turn case does.
 */

// The marker as a model writes it — bold, backticked or bare — and the rest of that line with it.
// Per line rather than per sentence: what follows is a claim being deleted whole, so sentence
// boundaries inside it do not matter.
const NOTE_LINE = /^[ \t]*[*_`]*\[system note\][*_`]*.*$/gim;

/**
 * What Slack gets when the fabrication was the entire reply.
 *
 * Substituted rather than falling back to the original — the opposite of what `dropCardPromises`
 * does when scrubbing empties the text. That choice is right there (dropping a whole conversational
 * reply to say nothing is worse than one over-promise) and wrong here: the text it would hand back
 * is the false claim itself, which is the one outcome this module exists to prevent.
 */
export const NOT_EXECUTED_NOTICE =
  "*Nothing has been executed.* This agent cannot run a change on its own — an approval card is " +
  "posted after the reply, and a human clicks it. The reply that stood here claimed the action had " +
  "already run, which was not true, so it was removed.";

export function stripFabricatedNote(reply: string): { text: string; dropped: number } {
  let dropped = 0;
  const text = reply.replace(NOTE_LINE, () => {
    dropped++;
    return "";
  });
  if (dropped === 0) return { text: reply, dropped: 0 };
  const tidy = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: tidy || NOT_EXECUTED_NOTICE, dropped };
}
