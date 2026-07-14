import React, { useState } from "react";
import { useApi } from "./components.jsx";
import { useHashRoute, go } from "./router.js";
import { initialTheme, applyTheme } from "./theme.js";
import { useLiveness } from "./live.js";
import { agoStr } from "./api.js";
import Overview from "./pages/Overview.jsx";
import Sessions from "./pages/Sessions.jsx";
import Proxy from "./pages/Proxy.jsx";
import Waste from "./pages/Waste.jsx";

const TABS = [
  ["overview", "Overview"],
  ["sessions", "Sessions"],
  ["proxy", "Proxy"],
  ["waste", "Waste"],
];

export default function App() {
  const route = useHashRoute();
  const [theme, setTheme] = useState(initialTheme);
  // App-level proxy poll (fast) — feeds the header pill, liveness and both the
  // Overview and Proxy pages, so nothing double-polls.
  const { data: proxy } = useApi("/proxy", { refreshMs: 5000 });
  const { now, lastPollAt, events, toasts, dismissToast } = useLiveness(proxy);

  const toggleTheme = () => {
    const t = theme === "light" ? "dark" : "light";
    applyTheme(t);
    setTheme(t);
  };

  const onTabKey = (e) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const btns = [...e.currentTarget.parentElement.querySelectorAll(".tab")];
    let i = Number(e.currentTarget.dataset.i);
    if (e.key === "ArrowLeft") i = (i - 1 + btns.length) % btns.length;
    if (e.key === "ArrowRight") i = (i + 1) % btns.length;
    if (e.key === "Home") i = 0;
    if (e.key === "End") i = btns.length - 1;
    btns[i].focus();
    btns[i].click();
  };

  const proxyUp = proxy ? proxy.up : true;
  const ago = agoStr(Math.max(0, Math.floor((now - lastPollAt) / 1000)));

  return (
    <div className="app">
      <header className="hdr">
        <div className="brand">
          stoke<span className="brandsub">cache keep-alive</span>
        </div>
        <nav className="navtabs" role="tablist" aria-label="Dashboard views">
          {TABS.map(([id, label], i) => {
            const active = route.tab === id;
            return (
              <button
                key={id}
                className={`tab ${active ? "active" : ""}`}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-i={i}
                onClick={() => go(id)}
                onKeyDown={onTabKey}
              >
                {label}
              </button>
            );
          })}
        </nav>
        <div className="fx" style={{ alignItems: "center", gap: 9 }}>
          <div
            className={`pill ${proxyUp ? "" : "down"}`}
            title={proxyUp ? "Keep-alive proxy is online" : "Keep-alive proxy is unreachable"}
          >
            <span className="dot" />
            {proxyUp ? "proxy up" : "proxy down"}
          </div>
          <div className="chip" aria-live="polite">
            <span className="livedot" />updated {ago}
          </div>
          <button
            className="iconbtn"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          >
            {theme === "light" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <main>
        {route.tab === "overview" && <Overview proxy={proxy} />}
        {route.tab === "sessions" && <Sessions route={route} />}
        {route.tab === "proxy" && (
          <Proxy proxy={proxy} now={now} lastPollAt={lastPollAt} events={events} />
        )}
        {route.tab === "waste" && <Waste route={route} />}
      </main>

      <div className="toaster" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() => dismissToast(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
