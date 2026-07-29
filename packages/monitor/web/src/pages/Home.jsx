import React from "react";
import { useApi, Skeleton } from "../components.jsx";
import Explainer from "../home/Explainer.jsx";
import Answer from "../home/Answer.jsx";
import StokeWorking from "../home/StokeWorking.jsx";
import Causes from "../home/Causes.jsx";
import ByProject from "../home/ByProject.jsx";
import LiveNow from "../home/LiveNow.jsx";
import Trend from "../home/Trend.jsx";

// Five sections that answer, in order: what is this, why should I care, where is
// it happening, what is stoke doing right now, and is it getting better.
//
// This page owns every fetch; the section components are presentational, so each
// one can be reasoned about and changed without touching data loading.
export default function Home({ proxy, now, lastPollAt }) {
  const { data: roll } = useApi("/waste?days=30&rollup=1", { refreshMs: 30000 });
  const { data: save30 } = useApi("/proxy/savings?days=30&byDay=1", { refreshMs: 30000 });
  const { data: saveAll } = useApi("/proxy/savings?days=all", { refreshMs: 60000 });
  const { data: spendDays } = useApi("/spend/daily-cost?days=30", { refreshMs: 60000 });
  const { data: ttl } = useApi("/ttl-advice", { refreshMs: 60000 });

  if (!roll) {
    return (
      <>
        <Head />
        <div className="answer">
          <Skeleton w={260} h={30} />
          <Skeleton w={340} h={30} mt={10} />
          <Skeleton w="100%" h={11} mt={20} />
        </div>
      </>
    );
  }

  const sessions = proxy?.live?.sessions ?? [];
  const warm = sessions.filter((s) => s.cacheStatus === "warm").length;
  const ttlSwitchCount = (ttl || []).filter(
    (t) => t.verdict !== "keep" && t.monthlyDeltaUsd > 0,
  ).length;

  return (
    <>
      <Head />
      <Explainer />

      <div className="seclabel"><span className="q">What</span> · this is your Claude Code bill</div>
      <Answer
        spendUsd={roll.spendUsd}
        avoidableUsd={roll.avoidableUsd}
        avoidablePct={roll.avoidablePct}
        windowDays={roll.windowDays}
      />
      <StokeWorking
        window30={save30}
        allTime={saveAll}
        warmCount={warm}
        proxyUp={proxy ? proxy.up : true}
      />

      {roll.causes.length > 0 && (
        <>
          <div className="seclabel"><span className="q">Why</span> · where it leaked, biggest first</div>
          <Causes causes={roll.causes} ttlSwitchCount={ttlSwitchCount} />
        </>
      )}

      {roll.byProject.length > 0 && (
        <>
          <div className="seclabel"><span className="q">Where</span> · which projects leaked the most</div>
          <ByProject byProject={roll.byProject} projectCount={roll.projectCount} />
        </>
      )}

      <div className="seclabel"><span className="q">When</span> · stoke is acting right now</div>
      <LiveNow sessions={sessions} now={now} lastPollAt={lastPollAt} />

      <div className="seclabel"><span className="q">Trend</span> · daily cost over 30 days</div>
      <Trend days={spendDays} avoidableByDay={roll.byDay} preventedByDay={save30?.byDay} />
    </>
  );
}

function Head() {
  return (
    <div className="hr">
      <div>
        <div className="pagetitle">Home</div>
        <div className="pagesub">What you spent, what was avoidable, and what stoke did about it.</div>
      </div>
    </div>
  );
}
