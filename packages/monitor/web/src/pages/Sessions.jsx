import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApi, Empty, Badge } from "../components.jsx";
import { Waterfall } from "../charts.jsx";
import { go, sessionsHash } from "../router.js";
import { money, dateShort, dayLabel, projectLabeler } from "../api.js";
import { filterSessions as filter, sortSessions as sortRows } from "../sessionsFilter.js";

const COLS = [
  ["project", "Project", false],
  ["model", "Model", false],
  ["started", "Started", false],
  ["turns", "Turns", true],
  ["cost", "Cost", true],
  ["ttl", "TTL", true],
];

export default function Sessions({ route }) {
  const id = route.parts[1] || null;
  if (id) return <SessionDetail id={id} query={route.query} />;
  return <SessionList query={route.query} />;
}

function SessionList({ query }) {
  const { data: list } = useApi("/sessions?limit=100");
  const [sort, setSort] = useState({ key: "cost", dir: "desc" });
  const [range, setRange] = useState("7d");
  const [search, setSearch] = useState("");
  const label = useMemo(() => projectLabeler((list || []).map((r) => r.project)), [list]);

  const rows = useMemo(() => {
    if (!list) return [];
    const filtered = filter(list, {
      project: query.project,
      model: query.model,
      day: query.day,
      range,
      query: search,
    });
    return sortRows(filtered, sort);
  }, [list, query.project, query.model, query.day, range, search, sort]);

  if (!list) return <Head sub="loading…" />;

  const projects = [...new Set(list.map((r) => r.project))];
  const models = [...new Set(list.map((r) => r.model))];
  const setQ = (k, v) => go(sessionsHash({ ...query, [k]: v }));
  const sortBy = (k) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }));

  return (
    <>
      <Head sub={`${rows.length} session${rows.length === 1 ? "" : "s"} · sorted by ${sort.key}`} />
      <div className="filterbar mb14">
        <select className="select" aria-label="Filter by project" value={query.project || "all"} onChange={(e) => setQ("project", e.target.value)}>
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>{label(p)}</option>
          ))}
        </select>
        <select className="select" aria-label="Filter by model" value={query.model || "all"} onChange={(e) => setQ("model", e.target.value)}>
          <option value="all">All models</option>
          {models.map((m) => (
            <option key={m} value={m}>{m?.replace("claude-", "")}</option>
          ))}
        </select>
        {[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([v, l]) => (
          <button key={v} className={`chipbtn ${range === v ? "on" : ""}`} onClick={() => setRange(v)}>{l}</button>
        ))}
        <input className="search" type="search" placeholder="Search id or project…" aria-label="Search sessions" value={search} onChange={(e) => setSearch(e.target.value)} />
        {query.day && (
          <span className="dayclr">
            day: {dayLabel(query.day)}
            <button className="linkbtn" onClick={() => setQ("day", null)} aria-label="Clear day filter">✕</button>
          </span>
        )}
      </div>

      {rows.length ? (
        <div className="card pad0">
          <table className="tbl">
            <thead>
              <tr>
                {COLS.map(([k, l, rt]) => {
                  const active = sort.key === k;
                  return (
                    <th key={k}>
                      <button
                        className={`th ${rt ? "rt" : ""} ${active ? "act" : ""}`}
                        onClick={() => sortBy(k)}
                        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      >
                        {l}<span className="arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = () => go("sessions/" + r.session_id);
                return (
                  <tr
                    key={r.session_id}
                    className="tr"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open();
                      }
                    }}
                  >
                    <td><div className="mono" style={{ fontSize: 12, color: "var(--dim)" }} title={r.project}>{label(r.project)}</div></td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.model?.replace("claude-", "")}</td>
                    <td className="num faint">{dateShort(r.started || r.ended)}</td>
                    <td className="rt num">{r.turns}</td>
                    <td className="rt num" style={{ fontWeight: 600 }}>{money(r.cost)}</td>
                    <td className="rt"><Badge cls="b-dim">{r.ttlMs >= 3600000 ? "1h" : "5m"}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No sessions match these filters">Try widening the date range or clearing filters.</Empty>
      )}
    </>
  );
}

function SessionDetail({ id, query }) {
  const { data: turns } = useApi(`/sessions/${id}`);
  const { data: list } = useApi("/sessions?limit=100");
  const wfRef = useRef(null);
  const flagIndex = query.turn != null ? Number(query.turn) : null;
  const meta = (list || []).find((s) => s.session_id === id);

  useEffect(() => {
    if (flagIndex == null || !wfRef.current) return;
    const t = setTimeout(() => {
      const wf = wfRef.current;
      const flag = wf?.querySelector(".wfrow.flag");
      if (wf && flag) wf.scrollTop = Math.max(0, flag.offsetTop - 90);
    }, 80);
    return () => clearTimeout(t);
  }, [flagIndex, turns]);

  const short = id.slice(0, 8);
  const back = () => go(sessionsHash(query));

  return (
    <>
      <div className="hr">
        <div>
          <button className="linkbtn mb14" onClick={back}>← All sessions</button>
          <div className="pagetitle mono">{short}</div>
          <div className="pagesub">
            {meta
              ? `${meta.project} · ${meta.model?.replace("claude-", "")} · ${meta.turns} turns · `
              : ""}
            {meta && <span className="num">{money(meta.cost)}</span>}
            {meta ? ` · TTL ${meta.ttlMs >= 3600000 ? "1h" : "5m"}` : "session detail"}
          </div>
        </div>
        {flagIndex != null && <Badge cls="b-serious">flagged turn highlighted</Badge>}
      </div>
      {!turns ? (
        <div className="card"><div className="skel" style={{ width: "100%", height: 200 }} /></div>
      ) : turns.length ? (
        <Waterfall turns={turns} flagIndex={flagIndex} scrollRef={wfRef} />
      ) : (
        <Empty title="No turns recorded for this session" />
      )}
    </>
  );
}

function Head({ sub }) {
  return (
    <div className="hr">
      <div>
        <div className="pagetitle">Sessions</div>
        <div className="pagesub">{sub}</div>
      </div>
    </div>
  );
}
