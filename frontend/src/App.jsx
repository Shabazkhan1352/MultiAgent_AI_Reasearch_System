import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

const STEPS = [
  { id: "search", title: "Search", hint: "Finds recent sources on the web" },
  { id: "read", title: "Read", hint: "Opens the most relevant page for detail" },
  { id: "write", title: "Write", hint: "Drafts the structured report" },
  { id: "critic", title: "Critique", hint: "Reviews and scores the draft" },
];

const EXAMPLES = [
  "How do solid-state batteries compare with lithium-ion?",
  "State of open-source large language models in 2026",
  "Effects of remote work on urban housing demand",
];

const HISTORY_KEY = "research-desk.history";

const emptySteps = () =>
  Object.fromEntries(STEPS.map((s) => [s.id, { status: "idle", seconds: null, output: "" }]));

/* ---------- helpers ---------- */

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* storage can be unavailable; history is a convenience only */
  }
}

function parseCritique(text = "") {
  const out = { score: null, strengths: [], improve: [], verdict: "" };
  const score = text.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  if (score) out.score = Number(score[1]);

  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^strengths\s*:/i.test(line)) section = "strengths";
    else if (/^areas to improve\s*:/i.test(line)) section = "improve";
    else if (/^one line verdict\s*:/i.test(line)) {
      section = "verdict";
      const rest = line.replace(/^one line verdict\s*:/i, "").trim();
      if (rest) out.verdict = rest;
    } else if (/^score\s*:/i.test(line)) section = null;
    else if (section === "verdict") out.verdict += (out.verdict ? " " : "") + line;
    else if (section && /^[-*•]/.test(line)) out[section].push(line.replace(/^[-*•]\s*/, ""));
  }
  const parsed = out.score !== null || out.strengths.length || out.improve.length || out.verdict;
  return parsed ? out : null;
}

function extractSources(text = "") {
  const found = text.match(/https?:\/\/[^\s)\]>"'<]+/g) || [];
  const seen = new Set();
  const list = [];
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?*_]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      list.push({ url, host: new URL(url).hostname.replace(/^www\./, "") });
    } catch {
      /* skip anything that is not a real URL */
    }
  }
  return list;
}

function fmtSeconds(s) {
  if (s == null) return "";
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function timeAgo(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- small components ---------- */

function StepMark({ status }) {
  if (status === "done")
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "error")
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  return null;
}

function Rail({ steps, liveSeconds }) {
  return (
    <ol className="rail" aria-label="Pipeline progress">
      {STEPS.map((s) => {
        const st = steps[s.id];
        const time =
          st.status === "running" ? fmtSeconds(liveSeconds[s.id]) : st.status === "done" ? fmtSeconds(st.seconds) : "";
        return (
          <li key={s.id} className={`rail-item is-${st.status}`}>
            <span className="rail-node">
              {st.status === "running" ? <span className="spinner" /> : <StepMark status={st.status} />}
            </span>
            <div className="rail-body">
              <div className="rail-head">
                <span className="rail-title">{s.title}</span>
                <span className="rail-time">{time}</span>
              </div>
              <p className="rail-hint">{s.hint}</p>
              {st.output && (
                <details className="rail-details">
                  <summary>Raw output</summary>
                  <pre>{st.output}</pre>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Critique({ feedback }) {
  const parsed = useMemo(() => parseCritique(feedback), [feedback]);
  if (!feedback) return <p className="empty">The critique appears here once the report is reviewed.</p>;
  if (!parsed) return <pre className="plain">{feedback}</pre>;
  return (
    <div className="critique">
      {parsed.score !== null && (
        <div className="score" role="img" aria-label={`Score ${parsed.score} out of 10`}>
          <span className="score-num">{parsed.score}</span>
          <span className="score-max">/ 10</span>
          <div className="score-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(parsed.score, 10) * 10}%` }} />
          </div>
        </div>
      )}
      {parsed.verdict && <p className="verdict">{parsed.verdict}</p>}
      <div className="critique-cols">
        {parsed.strengths.length > 0 && (
          <section>
            <h3>What works</h3>
            <ul>{parsed.strengths.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </section>
        )}
        {parsed.improve.length > 0 && (
          <section>
            <h3>What to improve</h3>
            <ul>{parsed.improve.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Sources({ report }) {
  const sources = useMemo(() => extractSources(report), [report]);
  if (!sources.length) return <p className="empty">No links were found in this report.</p>;
  return (
    <ul className="sources">
      {sources.map((s) => (
        <li key={s.url}>
          <a href={s.url} target="_blank" rel="noreferrer noopener">
            <span className="source-host">{s.host}</span>
            <span className="source-url">{s.url}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [topic, setTopic] = useState("");
  const [run, setRun] = useState(null); // null = home screen
  const [tab, setTab] = useState("report");
  const [history, setHistory] = useState(loadHistory);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sourceRef = useRef(null);
  const stepStart = useRef({});

  const running = run?.state === "running";

  // live timer for the step that is currently working
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const liveSeconds = useMemo(() => {
    const out = {};
    for (const [id, t] of Object.entries(stepStart.current)) out[id] = (now - t) / 1000;
    return out;
  }, [now, run]);

  const patchStep = (id, patch) =>
    setRun((r) => (r ? { ...r, steps: { ...r.steps, [id]: { ...r.steps[id], ...patch } } } : r));

  const start = useCallback((rawTopic) => {
    const t = rawTopic.trim();
    if (t.length < 3) return;
    sourceRef.current?.close();
    stepStart.current = {};
    setTab("report");
    setRun({ topic: t, state: "running", steps: emptySteps(), report: "", feedback: "", error: null });

    const es = new EventSource(`/api/research/stream?topic=${encodeURIComponent(t)}`);
    sourceRef.current = es;
    let finished = false;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "step") {
        if (msg.status === "running") {
          stepStart.current[msg.step] = Date.now();
          patchStep(msg.step, { status: "running" });
        } else {
          delete stepStart.current[msg.step];
          patchStep(msg.step, { status: "done", seconds: msg.seconds, output: msg.output });
          if (msg.step === "write") {
            setRun((r) => (r ? { ...r, report: msg.output } : r));
          }
        }
      } else if (msg.type === "done") {
        finished = true;
        es.close();
        setRun((r) => (r ? { ...r, state: "done", report: msg.report, feedback: msg.feedback } : r));
        setHistory((h) => {
          const next = [
            { id: Date.now(), topic: t, report: msg.report, feedback: msg.feedback, at: Date.now() },
            ...h,
          ];
          saveHistory(next);
          return next.slice(0, 12);
        });
      } else if (msg.type === "error") {
        finished = true;
        es.close();
        setRun((r) => {
          if (!r) return r;
          const steps = { ...r.steps };
          if (msg.step && steps[msg.step]) steps[msg.step] = { ...steps[msg.step], status: "error" };
          return { ...r, state: "error", steps, error: msg.message };
        });
      }
    };

    es.onerror = () => {
      if (finished) return;
      es.close();
      setRun((r) =>
        r && r.state === "running"
          ? { ...r, state: "error", error: "Lost the connection to the server. Check that the backend is running on port 8000." }
          : r
      );
    };
  }, []);

  const openFromHistory = (item) => {
    sourceRef.current?.close();
    const steps = emptySteps();
    for (const s of STEPS) steps[s.id].status = "done";
    setTab("report");
    setRun({ topic: item.topic, state: "done", steps, report: item.report, feedback: item.feedback, error: null });
  };

  const reset = () => {
    sourceRef.current?.close();
    setRun(null);
    setTopic("");
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(run.report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard can be blocked; the download button still works */
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    start(topic);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <button className="wordmark" onClick={reset} aria-label="Research desk, back to start">
          <span className="logo" aria-hidden="true">R</span>
          Research desk
        </button>
        {run && (
          <button className="btn ghost" onClick={reset}>
            New research
          </button>
        )}
      </header>

      {!run ? (
        <main className="home">
          <h1>What do you want researched?</h1>
          <p className="lede">
            Four agents search the web, read the best source, write a report and then critique it.
          </p>

          <form className="ask" onSubmit={onSubmit}>
            <label htmlFor="topic" className="sr-only">Research topic</label>
            <input
              id="topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Describe a topic or question"
              autoFocus
              maxLength={300}
            />
            <button className="btn primary" type="submit" disabled={topic.trim().length < 3}>
              Start research
            </button>
          </form>

          <div className="suggest">
            <span>Try</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => setTopic(ex)}>
                {ex}
              </button>
            ))}
          </div>

          {history.length > 0 && (
            <section className="recent" aria-labelledby="recent-h">
              <div className="recent-head">
                <h2 id="recent-h">Recent reports</h2>
                <button
                  className="link-btn"
                  onClick={() => {
                    setHistory([]);
                    saveHistory([]);
                  }}
                >
                  Clear
                </button>
              </div>
              <ul>
                {history.map((h) => (
                  <li key={h.id}>
                    <button onClick={() => openFromHistory(h)}>
                      <span className="recent-topic">{h.topic}</span>
                      <span className="recent-when">{timeAgo(h.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      ) : (
        <main className="workspace">
          <aside className="side">
            <p className="side-topic">{run.topic}</p>
            <Rail steps={run.steps} liveSeconds={liveSeconds} />
          </aside>

          <section className="main" aria-live="polite">
            {run.state === "error" && (
              <div className="alert" role="alert">
                <strong>The run stopped.</strong>
                <p>{run.error}</p>
                <button className="btn" onClick={() => start(run.topic)}>Try again</button>
              </div>
            )}

            <div className="tabs" role="tablist">
              {[
                ["report", "Report"],
                ["critique", "Critique"],
                ["sources", "Sources"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? "tab is-active" : "tab"}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
              <span className="tabs-spacer" />
              {run.report && (
                <>
                  <button className="btn ghost" onClick={copyReport}>{copied ? "Copied" : "Copy"}</button>
                  <button
                    className="btn ghost"
                    onClick={() => download(`${run.topic.slice(0, 50).replace(/[^\w]+/g, "-").toLowerCase()}.md`, run.report)}
                  >
                    Download .md
                  </button>
                </>
              )}
            </div>

            <div className="panel">
              {tab === "report" &&
                (run.report ? (
                  <article className="prose">
                    <ReactMarkdown
                      components={{
                        a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
                      }}
                    >
                      {run.report}
                    </ReactMarkdown>
                  </article>
                ) : (
                  <div className="waiting">
                    <div className="skeleton w1" />
                    <div className="skeleton w2" />
                    <div className="skeleton w3" />
                    <p>The report is written after the agents finish searching and reading.</p>
                  </div>
                ))}
              {tab === "critique" && <Critique feedback={run.feedback} />}
              {tab === "sources" && <Sources report={run.report} />}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
