"use client";

import { useEffect, useRef, useState } from "react";
import { Tldraw, type Editor } from "tldraw";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

type SessionBootstrap = {
  session_id: string;
  transport_status: string;
  board_status: string;
  backend_status: string;
  capabilities: string[];
  checked_at: string;
};

type BoardSnapshot = {
  session_id: string;
  board_status: string;
  backend_status: string;
  summary: string;
  shape_count: number;
  selected_count: number;
  synced_at: string;
};

type BoardMetrics = {
  summary: string;
  shapeCount: number;
  selectedCount: number;
};

function getBoardMetrics(editor: Editor | null): BoardMetrics {
  if (!editor) {
    return {
      summary: "The board is loading. No shapes have been captured yet.",
      shapeCount: 0,
      selectedCount: 0,
    };
  }

  const shapes = editor.getCurrentPageShapes();
  const selectedShapeIds = editor.getSelectedShapeIds();

  if (shapes.length === 0) {
    return {
      summary: "The board is empty right now.",
      shapeCount: 0,
      selectedCount: selectedShapeIds.length,
    };
  }

  const typeCounts = shapes.reduce<Record<string, number>>((counts, shape) => {
    counts[shape.type] = (counts[shape.type] ?? 0) + 1;
    return counts;
  }, {});

  const summary = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  return {
    summary: `${shapes.length} shapes on the board (${summary}). ${selectedShapeIds.length} selected.`,
    shapeCount: shapes.length,
    selectedCount: selectedShapeIds.length,
  };
}

export function TabloWorkspace() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [session, setSession] = useState<SessionBootstrap | null>(null);
  const [boardMetrics, setBoardMetrics] = useState<BoardMetrics>(() =>
    getBoardMetrics(null)
  );
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "synced">(
    "idle"
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const syncTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapSession() {
      setStatus("loading");
      setErrorMessage("");

      try {
        const [healthRes, sessionRes] = await Promise.all([
          fetch(`${API_BASE_URL}/health`),
          fetch(`${API_BASE_URL}/session/bootstrap`),
        ]);

        if (!healthRes.ok) {
          throw new Error(`Health check failed with status ${healthRes.status}`);
        }

        if (!sessionRes.ok) {
          throw new Error(
            `Session bootstrap failed with status ${sessionRes.status}`
          );
        }

        const data = (await sessionRes.json()) as SessionBootstrap;

        if (!cancelled) {
          setSession(data);
          setStatus("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Something went wrong while connecting to the backend."
          );
        }
      }
    }

    void bootstrapSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!editor) {
      setBoardMetrics(getBoardMetrics(null));
      return;
    }

    setBoardMetrics(getBoardMetrics(editor));

    const removeListener = editor.store.listen(
      () => {
        const nextMetrics = getBoardMetrics(editor);
        setBoardMetrics(nextMetrics);

        if (!session) {
          return;
        }

        if (syncTimeoutRef.current) {
          window.clearTimeout(syncTimeoutRef.current);
        }

        setSyncState("syncing");
        syncTimeoutRef.current = window.setTimeout(async () => {
          try {
            const res = await fetch(`${API_BASE_URL}/board/snapshot`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                session_id: session.session_id,
                summary: nextMetrics.summary,
                shape_count: nextMetrics.shapeCount,
                selected_count: nextMetrics.selectedCount,
              }),
            });

            if (!res.ok) {
              throw new Error(
                `Board snapshot failed with status ${res.status}`
              );
            }

            const data = (await res.json()) as BoardSnapshot;
            setSnapshot(data);
            setSyncState("synced");
          } catch (error) {
            setSyncState("idle");
            setErrorMessage(
              error instanceof Error
                ? error.message
                : "Something went wrong while syncing the board."
            );
          }
        }, 350);
      },
      { source: "user", scope: "document" }
    );

    return () => {
      if (syncTimeoutRef.current) {
        window.clearTimeout(syncTimeoutRef.current);
      }
      removeListener();
    };
  }, [editor, session]);

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.2),_transparent_30%),linear-gradient(180deg,_#113c66_0%,_#0a1d2f_50%,_#07111a_100%)] text-slate-50">
      <div className="relative flex min-h-screen flex-col">
        <header className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-4 py-4 md:px-6">
          <div className="max-w-xl rounded-[24px] border border-white/10 bg-slate-950/45 px-4 py-3 backdrop-blur">
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan-200/75">
              Tablo Day 1
            </p>
            <h1 className="mt-2 text-lg font-semibold tracking-tight text-white md:text-xl">
              Board workspace
            </h1>
            <p className="mt-2 text-xs leading-5 text-slate-300 md:text-sm">
              The first day focuses on the core surface: a full-screen canvas,
              backend readiness, and the session shell that voice will connect
              into next.
            </p>
          </div>

          <div className="hidden gap-2 md:flex">
            <div className="rounded-full border border-emerald-300/25 bg-emerald-400/10 px-3 py-1.5 text-xs text-slate-100">
              board active
            </div>
            <div className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-slate-100">
              {status === "loading"
                ? "connecting"
                : status === "ready"
                  ? "backend ready"
                  : "backend error"}
            </div>
          </div>
        </header>

        <section className="flex min-h-screen flex-1">
          <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0">
              <Tldraw onMount={setEditor} autoFocus />
            </div>
          </div>

          <aside className="hidden w-[360px] shrink-0 border-l border-white/10 bg-slate-950/62 p-4 backdrop-blur xl:flex xl:flex-col">
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/70">
                Session status
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Day 1 establishes the board shell and backend connection state.
                Voice transport, live transcript, and AI streaming connect into
                this session layer next.
              </p>
            </div>

            <div className="mt-4 flex-1 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                Workspace readiness
              </p>

              {status === "error" ? (
                <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100">
                  {errorMessage}
                </div>
              ) : null}

              {status === "loading" ? (
                <div className="mt-4 rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-6 text-slate-300">
                  Connecting the board workspace to the backend session shell...
                </div>
              ) : null}

              {session ? (
                <div className="mt-4 space-y-4 text-sm leading-6 text-slate-200">
                  <div>
                    <p className="font-medium text-white">Session ID</p>
                    <p className="mt-1">{session.session_id}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Backend status</p>
                    <p className="mt-1">{session.backend_status}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Transport status</p>
                    <p className="mt-1">{session.transport_status}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Board status</p>
                    <p className="mt-1">{session.board_status}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Live board metrics</p>
                    <p className="mt-1">{boardMetrics.summary}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Capabilities</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {session.capabilities.map((capability) => (
                        <span
                          key={capability}
                          className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-xs text-slate-200"
                        >
                          {capability}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="font-medium text-white">Board sync</p>
                    <p className="mt-1">
                      {syncState === "syncing"
                        ? "Syncing board changes to backend..."
                        : snapshot
                          ? `Last synced at ${new Date(snapshot.synced_at).toLocaleTimeString()}`
                          : "Waiting for first board change."}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </section>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4 md:px-6 md:pb-6">
          <div className="pointer-events-auto mx-auto max-w-5xl rounded-[30px] border border-white/10 bg-slate-950/70 p-4 shadow-[0_24px_80px_rgba(3,8,20,0.45)] backdrop-blur">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="max-w-3xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/75">
                  Session shell
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Day 1 now proves three visible things: the board is active,
                  the frontend can establish a backend session, and board
                  changes are being summarized and synced to the backend.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-slate-200">
                  {boardMetrics.summary}
                </div>
                <div className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-3 text-sm font-semibold text-cyan-100">
                  {syncState === "syncing"
                    ? "Syncing changes"
                    : snapshot
                      ? `Backend synced ${snapshot.shape_count} shapes`
                      : "Waiting for board change"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
