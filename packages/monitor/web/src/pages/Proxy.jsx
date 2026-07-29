import React from "react";
import { useApi, Stat, Badge } from "../components.jsx";
import { BudgetBar } from "../charts.jsx";
import { sessionCountdown } from "../live.js";
import { money, pct, tok, mmss, clock, verdictLabel, evColor } from "../api.js";
import { projectName } from "../lib/projectName.js";

const isActive = (s) => s.cacheStatus === "warm" || s.cacheStatus === "paused";
const statusBadgeCls = (s) =>
  s === "warm" ? "b-good" : s === "paused" ? "b-warn" : "b-dim";

export default function Proxy({ proxy, now, lastPollAt, events }) {
  const { data: cache } = useApi("/cache");
  const { data: ttl } = useApi("/ttl-advice");
  // Finished sessions are the majority (16 of 22 on a typical day) and carry no
  // countdown and no savings, so they start collapsed.
  const [showInactive, setShowInactive] = React.useState(false);
  const [showNoChange, setShowNoChange] = React.useState(false);

  if (!proxy) {
    return (
      <>
        <Head />
        <div className="grid cards4 mb14">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card"><div className="skel" style={{ width: 80, height: 12 }} /><div className="skel mt14" style={{ width: "100%", height: 36 }} /></div>
          ))}
        </div>
      </>
    );
  }

  const up = proxy.up;
  const live = proxy.live || {};
  const budget = live.budget || {};
  const t = proxy.today || {};
  const ttlText = live.plan === "subscription" ? "3600s TTL" : "300s TTL";

  return (
    <>
      <Head />
      <div className="grid cards4 mb14">
        <div className="card">
          <div className="klabel">Status</div>
          <div className="fx mt10" style={{ alignItems: "center", gap: 9 }}>
            <Badge cls={up ? "b-good" : "b-crit"}>{up ? "online" : "offline"}</Badge>
          </div>
          <div className="kdelta">{up ? `up ${((live.uptimeSeconds || 0) / 3600).toFixed(1)}h` : "unreachable"}</div>
        </div>
        <div className="card">
          <div className="klabel">Plan</div>
          <div className="kval" style={{ fontSize: 20, textTransform: "capitalize" }}>{live.plan || "—"}</div>
          <div className="kdelta">{ttlText}</div>
        </div>
        <div className="card">
          <div className="klabel">Daily ping budget</div>
          <div className="kval num" style={{ fontSize: 20 }}>{money(budget.spentToday)} / {money(budget.dailyCapUsd)}</div>
          <BudgetBar spent={budget.spentToday} cap={budget.dailyCapUsd} />
        </div>
        <div className="card">
          <div className="klabel">Monthly ping budget</div>
          <div className="kval num" style={{ fontSize: 20 }}>{money(budget.spentMonth)} / {money(budget.monthlyCapUsd)}</div>
          <BudgetBar spent={budget.spentMonth} cap={budget.monthlyCapUsd} />
        </div>
      </div>

      {!up ? (
        <div className="degraded">
          <div className="fx" style={{ alignItems: "center", gap: 10 }}>
            <Badge cls="b-crit">proxy down</Badge>
            <span style={{ fontWeight: 600 }}>Keep-alive inactive</span>
          </div>
          <div className="dim" style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6, maxWidth: 640 }}>
            The keep-alive proxy is unreachable, so no cache pings are firing and rebuilds are no longer being
            prevented. <strong style={{ color: "var(--text)" }}>Spend tracking still works</strong> — Home,
            Leaks and Sessions remain accurate. Start it with <code>stoke start</code> to resume keep-alive.
          </div>
        </div>
      ) : (
        <>
          <div className="grid cards4 mb14">
            <Stat label="Net saved today" value={money(t.netSavedUsd)} accent="var(--good)" sub={`${money(t.savedUsd)} prevented − ${money(t.pingSpendUsd)} pings`} />
            <Stat label="Rebuilds avoided" value={t.rebuildsAvoided ?? 0} sub={`pings: ${t.pingsFired ?? 0} fired · ${t.pingsSkipped ?? 0} skipped`} />
            <Stat label="Resumes today" value={resumeTotal(t.resumes)} sub={`${t.resumes?.survived ?? 0} survived · ${t.resumes?.partial ?? 0} partial · ${t.resumes?.rebuilt ?? 0} rebuilt`} />
            <Stat label="Cache hit rate" value={cache ? pct(cache.hitRate) : "—"} accent="var(--good)" sub={cache ? `${tok(cache.totalRead)} read all-time` : ""} />
          </div>

          <div className="grid cards2" style={{ gridTemplateColumns: "1.25fr 1fr", alignItems: "start" }}>
            <div>
              <div className="klabel mb14">Live sessions — countdown to next cache ping</div>
              <div className="grid" style={{ gap: 12 }}>
                {(live.sessions || []).filter((s) => showInactive || isActive(s)).map((s) => {
                  const cd = sessionCountdown(s, now, lastPollAt);
                  const idle = (s.idleSec || 0) + Math.max(0, (now - lastPollAt) / 1000);
                  return (
                    <div key={s.key} className={`livecard ${s.cacheStatus}`}>
                      <div className="fx" style={{ alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ fontWeight: 600 }} className="mono">{projectName(s.projectPath)}</div>
                          <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                            {s.model?.replace("claude-", "")} · idle {mmss(idle)} · {s.pingCount5h ?? 0} pings/5h
                          </div>
                        </div>
                        <Badge cls={statusBadgeCls(s.cacheStatus)}>{s.cacheStatus}</Badge>
                      </div>
                      <div className="countdown mt14">
                        <div className="cdtop">
                          <span className="dim" style={{ fontSize: 12 }}>next ping in</span>
                          <span className={`cdtime num ${cd.pinging ? "pinging" : ""}`}>
                            {!cd.active ? "—" : cd.pinging ? "ping fired" : mmss(cd.seconds)}
                          </span>
                        </div>
                        <div className="cdbar">
                          <div className={`cdfill ${cd.seconds < 30 ? "warnc" : ""}`} style={{ width: (cd.active ? cd.frac * 100 : 0).toFixed(1) + "%" }} />
                        </div>
                      </div>
                      <div className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
                        saved all-time <span className="num" style={{ color: "var(--good)" }}>{money(s.savedUsdAllTime)}</span> · ping cost <span className="num">{money(s.pingCostUsd5h)}</span>
                      </div>
                    </div>
                  );
                })}
                {(live.sessions || []).length === 0 && (
                  <div className="empty">No sessions tracked yet — start a Claude Code conversation through the proxy.</div>
                )}
                {(() => {
                  const dead = (live.sessions || []).filter((s) => !isActive(s)).length;
                  if (!dead) return null;
                  return (
                    <div className="morelink">
                      <button onClick={() => setShowInactive((v) => !v)}>
                        {showInactive ? "Hide" : "Show"} {dead} finished session{dead === 1 ? "" : "s"}
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>

            <div>
              <div className="klabel mb14">Live events</div>
              <div className="card pad0">
                <div className="ticker">
                  {events.length ? (
                    events.map((e) => (
                      <div key={e.id} className="ev">
                        <span className="evdot" style={{ background: evColor(e.kind) }} />
                        <div>
                          <div>{e.text}</div>
                          <div className="faint mono" style={{ fontSize: 11 }}>{projectName(e.project)}</div>
                        </div>
                        <span className="evtime num">{clock(e.ts)}</span>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: "16px", color: "var(--dim)", fontSize: 12.5 }}>Watching for pings, resumes and prevented rebuilds…</div>
                  )}
                </div>
              </div>

              <div className="klabel mb14 mt20">Cache setting by project</div>
              <div className="card pad0">
                {(() => {
                  const rows = ttl || [];
                  // A row that says "switch" and then "no change" is advice that
                  // contradicts itself — 20 of 28 read that way. Only rows with a
                  // real saving are actionable; the rest collapse to a count.
                  const actionable = rows.filter((a) => a.verdict !== "keep" && a.monthlyDeltaUsd > 0);
                  const rest = rows.length - actionable.length;
                  const visible = showNoChange ? rows : actionable;
                  return (
                    <>
                      {visible.map((a, i) => {
                        const worth = a.verdict !== "keep" && a.monthlyDeltaUsd > 0;
                        return (
                          <div key={i} className="attr" style={{ padding: "12px 16px", gridTemplateColumns: "1fr auto" }}>
                            <div>
                              <div className="mono" style={{ fontWeight: 600 }}>{projectName(a.project)}</div>
                              <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{a.reasoning}</div>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <Badge cls={worth ? "b-good" : "b-dim"}>{worth ? verdictLabel(a.verdict) : "Leave as is"}</Badge>
                              <div className="num" style={{ fontSize: 12, marginTop: 5, color: "var(--dim)" }}>
                                {worth ? `save ${money(a.monthlyDeltaUsd)}/mo` : "no change"}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {!rows.length && (
                        <div style={{ padding: 16, color: "var(--dim)", fontSize: 12.5 }}>No advice yet.</div>
                      )}
                      {rows.length > 0 && !actionable.length && !showNoChange && (
                        <div style={{ padding: 16, color: "var(--dim)", fontSize: 12.5 }}>
                          Every project is already on the right cache setting.
                        </div>
                      )}
                      {rest > 0 && (
                        <div className="morelink" style={{ padding: "10px 16px" }}>
                          <button onClick={() => setShowNoChange((v) => !v)}>
                            {showNoChange ? "Hide" : "Show"} {rest} project{rest === 1 ? "" : "s"} that need no change
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

const resumeTotal = (r = {}) => (r.survived || 0) + (r.partial || 0) + (r.rebuilt || 0);

function Head() {
  return (
    <div className="hr">
      <div>
        <div className="pagetitle">Keep-alive</div>
        <div className="pagesub">How stoke holds your cache open between messages</div>
      </div>
    </div>
  );
}
