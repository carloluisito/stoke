// Detector types are engineering labels ("cache_expiry"). A first-time viewer
// needs to know what happened to them and what to do about it, in their own
// words. This file is the only place that copy lives.
//
// `fix` is the single action that addresses the cause. `route` is the hash tab
// the card links to. Keep `title` and `why` free of jargon — they render on the
// landing screen, and __tests__/causes.test.js enforces that mechanically.

export const CAUSES = {
  cache_expiry: {
    title: "You walked away and the cache went cold",
    why: "Claude keeps your conversation ready for a few minutes. Idle past that and the next message pays to rebuild the whole thing from scratch.",
    fix: "Use the longer cache",
    route: "proxy",
  },
  cache_invalidation: {
    title: "You edited CLAUDE.md mid-session",
    why: "Changing your instructions or settings while a session is running throws away everything held for it, so the conversation gets billed again from the start.",
    fix: "Edit instructions between sessions",
    route: "waste",
  },
  session_bloat: {
    title: "Sessions ran near the context limit",
    why: "Once a conversation is very large, every new message pays for all the dead history behind it. Compacting clears that out.",
    fix: "Run /compact on long sessions",
    route: "waste",
  },
  output_verbosity: {
    title: "Replies were longer than they needed to be",
    why: "What Claude writes costs about five times what it reads. These replies ran far longer than the task asked for.",
    fix: "Ask for concise output",
    route: "waste",
  },
  model_mismatch: {
    title: "A top-tier model did mechanical work",
    why: "Bulk searching and file sweeps don't need the most expensive model — a cheaper one does them for a fraction of the price.",
    fix: "Delegate searches to a cheaper model",
    route: "waste",
  },
};

export const KNOWN_TYPES = Object.keys(CAUSES);

// The automatic fixes stoke applies, keyed by the internal lever id the
// attribution table reports. Same reasoning as CAUSES: "efficiency_conventions"
// is an implementation detail, not something a reader can act on.
const FIXES = {
  cache_expiry_warning: "Warns you before the cache goes cold",
  context_bloat_warning: "Warns you when a session gets too large",
  bloat_hard_gate: "Blocks a session that is past the safe context size",
  efficiency_conventions: "Injects the cost-saving conventions into each session",
  session_cost_record: "Records what each session cost",
  model_downshift: "Moves mechanical work to a cheaper model",
};

/** Plain-language name for an optimizer lever; falls back to the raw id. */
export function fixLabel(lever) {
  return FIXES[lever] || lever;
}

/**
 * Never returns undefined — an unrecognised type still renders something honest
 * rather than a blank card. A new detector added server-side will show up here
 * with its raw name until someone writes copy for it.
 */
export function causeFor(type) {
  return (
    CAUSES[type] || {
      title: type || "Unrecognised finding",
      why: "stoke flagged this as avoidable spend but has no plain-language explanation for it yet.",
      fix: "See the sessions",
      route: "waste",
    }
  );
}
