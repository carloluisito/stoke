import React, { useEffect, useRef, useState } from "react";
import { useApi, Skeleton, Stat, Badge } from "../components.jsx";
import { SpendChart, Sparkline, dayTotal } from "../charts.jsx";
import { go } from "../router.js";
import { money, pct, typeLabel } from "../api.js";

// Ease a displayed number toward `target` so headline values count up on a poll.
function useCountUp(target) {
  const [val, setVal] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  const raf = useRef(0);
  useEffect(() => {
    if (target == null) return;
    cancelAnimationFrame(raf.current);
    const start = performance.now();
    const a = from.current;
    const step = (t) => {
      const p = Math.min(1, (t - start) / 700);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(a + (target - a) * e);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else from.current = target;
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  return val;
}

// A waste finding lives in the Waste tab; deep-link into its session if we have one.
const findingLink = (f) => (f.session_id ? "sessions/" + f.session_id : "waste");

export default function Overview({ proxy }) {
  const { data: overview } = useApi("/overview");
  const { data: spend } = useApi("/spend/daily-cost?days=30");
  const { data: waste } = useApi("/waste");
  const { data: ttl } = useApi("/ttl-advice");
  const { data: cache } = useApi("/cache");

  const net = overview?.netCost;
  const dispNet = useCountUp(net?.netCostUsd);
  const dispToday = useCountUp(overview?.today);

  if (!overview || !spend) {
    return (
      <>
        <PageHead />
        <div className="grid cards2 mb14">
          <div className="hero">
            <Skeleton w={120} h={14} />
            <Skeleton w={220} h={64} mt={14} />
            <Skeleton w="100%" h={56} mt={14} />
          </div>
          <div className="grid" style={{ gap: 14 }}>
            <div className="card"><Skeleton w={80} h={12} /><Skeleton w="100%" h={40} mt={14} /></div>
            <div className="card"><Skeleton w={80} h={12} /><Skeleton w="100%" h={40} mt={14} /></div>
          </div>
        </div>
      </>
    );
  }

  const last7 = spend.slice(-7);
  const totals = last7.map(dayTotal);
  const weekTotal = totals.reduce((a, b) => a + b, 0);
  const proxyUp = proxy ? proxy.up : overview.proxyUp;
  const warm = proxy?.live?.sessions?.filter((s) => s.cacheStatus === "warm").length ?? 0;
  const today = proxy?.today;

  const findings = waste?.findings || [];
  const topWaste = [...findings].sort((a, b) => b.wastedUsd - a.wastedUsd)[0];
  const ttlSwitch = (ttl || []).find((t) => t.verdict !== "keep" && t.monthlyDeltaUsd > 0);
  const bloat = findings.find((f) => f.type === "session_bloat");
  const doNow = [];
  if (topWaste)
    doNow.push({
      tone: "serious",
      kicker: "Top waste",
      title: `${money(topWaste.wastedUsd)} · ${typeLabel(topWaste.type)}`,
      desc: topWaste.recommendation,
      cta: "View finding →",
      onClick: () => go(findingLink(topWaste)),
    });
  if (ttlSwitch)
    doNow.push({
      tone: "good",
      kicker: "TTL advice",
      title: `Switch ${ttlSwitch.project} to 1h cache`,
      desc: `Est. save ~${money(ttlSwitch.monthlyDeltaUsd)}/mo. ${ttlSwitch.reasoning}`,
      cta: "Review TTL advice →",
      onClick: () => go("proxy"),
    });
  if (bloat)
    doNow.push({
      tone: "warning",
      kicker: "Session bloat",
      title: `${bloat.project} near context cap`,
      desc: bloat.recommendation,
      cta: "Open session →",
      onClick: () => go(findingLink(bloat)),
    });

  return (
    <>
      <PageHead />
      <div className="grid cards2 mb14" style={{ gridTemplateColumns: "1.35fr 1fr" }}>
        <div className="hero">
          <div className="herolabel">
            Net cost today<Badge cls="b-dim">spend + pings − prevented</Badge>
          </div>
          <div className="heronum num">{money(dispNet)}</div>
          <div className="eq">
            <div className="eqterm"><span className="eqv num">{money(net.spendUsd)}</span><span className="eqk">spend</span></div>
            <span className="eqop">+</span>
            <div className="eqterm"><span className="eqv num">{money(net.pingSpendUsd)}</span><span className="eqk">ping cost</span></div>
            <span className="eqop">−</span>
            <div className="eqterm">
              <span className="eqv num" style={{ color: "var(--good)" }}>{money(net.preventedUsd)}</span>
              <span className="eqk">prevented ({net.rebuildsAvoided})</span>
            </div>
          </div>
          <div className="mt20">
            <div className="klabel">7-day spend trend</div>
            <div className="mt14"><Sparkline values={totals} height={30} /></div>
          </div>
        </div>
        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <div className="klabel">Proxy status</div>
            <div className="fx mt10" style={{ alignItems: "center", gap: 10 }}>
              <Badge cls={proxyUp ? "b-good" : "b-crit"}>{proxyUp ? "proxy up" : "proxy down"}</Badge>
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 9 }}>
              {proxyUp
                ? `Keep-alive active · ${warm} session${warm === 1 ? "" : "s"} warm`
                : "Keep-alive inactive — spend tracking still works"}
            </div>
          </div>
          <Stat
            label="Net saved by keep-alive today"
            value={today ? money(today.netSavedUsd) : "—"}
            accent="var(--good)"
            sub={today ? `${money(today.savedUsd)} prevented − ${money(today.pingSpendUsd)} pings` : "proxy unreachable"}
          />
        </div>
      </div>

      <div className="klabel mb14">Do this now</div>
      <div className="donow mb18">
        {doNow.length ? (
          doNow.map((a, i) => (
            <button key={i} className={`act ${a.tone}`} onClick={a.onClick}>
              <span className="actk">{a.kicker}</span>
              <span className="acttitle">{a.title}</span>
              <span className="actdesc">{a.desc}</span>
              <span className="actcta">{a.cta}</span>
            </button>
          ))
        ) : (
          <div className="act good">
            <span className="actk">All clear</span>
            <span className="acttitle">Nothing urgent</span>
            <span className="actdesc">No waste findings or TTL switches to act on right now.</span>
          </div>
        )}
      </div>

      <div className="card pad0 mb14">
        <div style={{ padding: "18px 20px 4px" }}>
          <div className="hr" style={{ margin: 0 }}>
            <div>
              <div className="pagetitle">Spend by day</div>
              <div className="pagesub">Stacked by token type · click a day to see its sessions</div>
            </div>
            <div className="num" style={{ fontSize: 13, color: "var(--dim)" }}>
              7-day total <span style={{ color: "var(--text)", fontWeight: 600 }}>{money(weekTotal)}</span>
            </div>
          </div>
        </div>
        <div style={{ padding: "0 18px 8px" }}>
          <SpendChart days={last7} selectedDay={null} onSelectDay={(day) => go(`sessions?day=${day}`)} />
        </div>
      </div>

      <div className="grid cards4">
        <Stat label="Today spend" value={money(dispToday)} sub="gross, before prevented" />
        <Stat label="This week" value={money(overview.week)} sub="rolling 7-day" />
        <Stat
          label="Effective $/MTok"
          value={overview.effectiveDollarsPerMTok != null ? `$${overview.effectiveDollarsPerMTok.toFixed(2)}` : "—"}
          sub="blended, all token types"
        />
        <Stat
          label="Cache saved all-time"
          value={money(overview.cacheSavedUsd)}
          accent="var(--good)"
          sub={cache ? `${pct(cache.hitRate)} hit rate` : ""}
        />
      </div>
    </>
  );
}

function PageHead() {
  return (
    <div className="hr">
      <div>
        <div className="pagetitle">Overview</div>
        <div className="pagesub">How am I doing, and what should I do about it.</div>
      </div>
    </div>
  );
}
