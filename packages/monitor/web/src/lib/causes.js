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
  cache_expiry_warning: "Warns you before the conversation goes cold",
  context_bloat_warning: "Warns you when a session grows too large",
  bloat_hard_gate: "Holds back messages from an oversized session",
  efficiency_conventions: "Adds the cost-saving rules to each session",
  wasteful_read_warning: "Stops Claude re-reading a file it already has",
  session_cost_record: "Records what each session cost",
  model_downshift: "Moves mechanical work to a cheaper model",
};

/** Plain-language name for an optimizer lever; falls back to the raw id. */
export function fixLabel(lever) {
  return FIXES[lever] || lever;
}

// ---------------------------------------------------------------------------
// The intervention log stores the message each hook wrote for *Claude*, not for
// a person: "injected efficiency conventions", "BLOCKED prompt at ~409k context
// tokens". Nobody reading the dashboard knows what those mean. These turn each
// stored message into what actually happened to the reader.
//
// The hooks are left alone on purpose: their messages are also the text Claude
// and the terminal see, and rows already in the database keep the old wording
// forever. Translating at render time covers both.

const grab = (msg, re) => {
  const m = re.exec(msg || "");
  return m ? m[1] : null;
};

const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;

// The hooks record every gap in minutes, which reads fine at 40 and badly at
// 1488. Scale the unit to the size of the gap.
const humanMinutes = (raw) => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (v < 90) return plural(Math.round(v), "minute");
  const hours = Math.round(v / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
};

/** Colour/label for the kind of step stoke took. */
export const KIND_BADGE = {
  blocked: "b-crit",
  warned: "b-warn",
  guided: "b-accent",
  logged: "b-dim",
  watched: "b-dim",
};

/**
 * Plain-language rendering of one row from the interventions table.
 * Returns { kind, title, detail, routine } — `kind` is what stoke did, `title`
 * is what happened, `detail` is why it mattered. Never returns undefined.
 *
 * `routine` marks a row that happens on every session no matter what, so it
 * carries no news: the cost note written at the end of each session, and the
 * rules added at the start of each one. 435 of the 500 most recent rows were
 * one of those two, repeating the same sentence. They stay reachable behind a
 * toggle instead of burying the rows where stoke actually intervened.
 *
 * It is deliberately not a per-lever flag: efficiency_conventions covers both
 * the routine session-start rules and the "you're being wordy" nudge, which is
 * real news.
 */
export function interventionCopy(lever, message = "", mode = "enforce") {
  const m = String(message || "");
  const watching = mode === "observe";
  const out = (kind, title, detail, routine = false) => ({
    kind: watching ? "watched" : kind,
    title,
    detail,
    routine,
  });

  switch (lever) {
    case "bloat_hard_gate": {
      const k = grab(m, /~(\d+)k/);
      return out(
        "blocked",
        k
          ? `Held back a message that would have re-billed ~${k}k tokens`
          : "Held back a message from an oversized session",
        "The conversation had grown past your safe-size limit, so stoke stopped the message and asked for /compact first. Sending it again pushes through.",
      );
    }

    case "wasteful_read_warning": {
      const file = grab(m, /re-read of (.+?) \(/) || grab(m, /\]\s(.+?) \(/);
      const kb = grab(m, /\((\d+)KB\)/);
      const blocked = /^BLOCKED/.test(m);
      return out(
        blocked ? "blocked" : "warned",
        blocked
          ? "Blocked a re-read of a file Claude already had"
          : "Flagged a re-read of a file Claude already had",
        `${file || "A large file"}${kb ? ` (${kb}KB)` : ""} had already been read in this session. Reading all of it again re-bills all of it, so stoke pointed Claude at just the part it needed.`,
      );
    }

    case "cache_expiry_warning": {
      const gap = grab(m, /gap (\d+)m/);
      const ttl = grab(m, /TTL (\d+)m/);
      const k = grab(m, /~(\d+)k/);
      return out(
        "warned",
        "Warned you the conversation had gone cold",
        gap && ttl
          ? `You were away ${humanMinutes(gap)}, past the ${ttl}-minute window, so this message paid to rebuild ${k && k !== "0" ? `about ${k}k tokens` : "the conversation"} from scratch.`
          : "The conversation had to be rebuilt from scratch because the idle window had passed.",
      );
    }

    case "context_bloat_warning": {
      const k = grab(m, /~(\d+)k/);
      return out(
        "warned",
        k ? `Warned you the conversation had grown to ~${k}k tokens` : "Warned you the conversation had grown large",
        "Every new message re-bills the whole history behind it. /compact clears out what is no longer needed.",
      );
    }

    case "efficiency_conventions": {
      if (/observe only/i.test(m)) {
        return out(
          "watched",
          "Watched this session without changing anything",
          "The cost-saving rules are set to watch-only, so nothing was added to the session.",
          true,
        );
      }
      const tokens = grab(m, /~(\d+) tokens/);
      if (tokens) {
        return out(
          "guided",
          "Asked Claude to write shorter replies",
          `Recent replies averaged about ${Number(tokens).toLocaleString()} tokens. What Claude writes costs roughly five times what it reads.`,
        );
      }
      return out(
        "guided",
        "Told Claude how to keep this session cheap",
        "At the start of every session stoke adds a short set of rules: keep replies brief, never re-read a file it already has, and hand bulk searching to a cheaper model.",
        true,
      );
    }

    case "session_cost_record": {
      const cost = grab(m, /\$([0-9.]+)/);
      const turns = grab(m, /across (\d+) turns/);
      return out(
        "logged",
        cost ? `Recorded the session cost: $${Number(cost).toFixed(2)}` : "Recorded the session cost",
        turns ? `${turns} message${turns === "1" ? "" : "s"} so far. Bookkeeping only — stoke did not step in here.` : "Bookkeeping only — stoke did not step in here.",
        true,
      );
    }

    default:
      // A lever added server-side renders its raw message rather than nothing.
      // Always a string: a blank message with an unknown lever must still show
      // something, not `null`.
      return out("logged", m || String(fixLabel(lever) ?? "Something stoke did"), "");
  }
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
