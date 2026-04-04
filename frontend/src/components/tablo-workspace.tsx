"use client";

import { useEffect, useRef, useState } from "react";
import { Tldraw, type Editor } from "tldraw";
import { LiveKitRoom, RoomAudioRenderer, VoiceAssistantControlBar } from "@livekit/components-react";
import "@livekit/components-styles";

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

type RealtimeConfig = {
  configured: boolean;
  livekit_url: string | null;
  backend_conversion_boundary: string;
  livekit_audio_hz: number;
  gemini_input_hz: number;
  gemini_output_hz: number;
  notes: string[];
};

type LiveKitTokenResponse = {
  server_url: string;
  room_name: string;
  participant_identity: string;
  token: string;
};

type LiveKitRoomLike = {
  connect: (
    url: string,
    token: string,
    options?: { autoSubscribe?: boolean }
  ) => Promise<void>;
  disconnect: () => void;
  localParticipant: {
    setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  };
  on: (event: string, listener: (...args: unknown[]) => void) => void;
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
  const [realtimeConfig, setRealtimeConfig] = useState<RealtimeConfig | null>(
    null
  );
  const [roomState, setRoomState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [roomDetails, setRoomDetails] = useState<{
    roomName: string;
    participantIdentity: string;
    serverUrl?: string;
    token?: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const syncTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapSession() {
      setStatus("loading");
      setErrorMessage("");

      try {
        const [healthRes, sessionRes, realtimeRes] = await Promise.all([
          fetch(`${API_BASE_URL}/health`),
          fetch(`${API_BASE_URL}/session/bootstrap`),
          fetch(`${API_BASE_URL}/realtime/config`),
        ]);

        if (!healthRes.ok) {
          throw new Error(`Health check failed with status ${healthRes.status}`);
        }

        if (!sessionRes.ok) {
          throw new Error(
            `Session bootstrap failed with status ${sessionRes.status}`
          );
        }

        if (!realtimeRes.ok) {
          throw new Error(
            `Realtime config failed with status ${realtimeRes.status}`
          );
        }

        const sessionData = (await sessionRes.json()) as SessionBootstrap;
        const realtimeData = (await realtimeRes.json()) as RealtimeConfig;

        if (!cancelled) {
          setSession(sessionData);
          setRealtimeConfig(realtimeData);
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

  async function connectLiveKit() {
    if (!session || !realtimeConfig?.configured) {
      setErrorMessage(
        "LiveKit is not configured yet. Add LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to the backend."
      );
      return;
    }

    setRoomState("connecting");
    setErrorMessage("");

    try {
      const tokenRes = await fetch(`${API_BASE_URL}/livekit/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: session.session_id,
        }),
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        throw new Error(
          `LiveKit token request failed with status ${tokenRes.status}: ${errorText}`
        );
      }

      const tokenData = (await tokenRes.json()) as LiveKitTokenResponse;

      setRoomDetails({
        roomName: tokenData.room_name,
        participantIdentity: tokenData.participant_identity,
        serverUrl: tokenData.server_url,
        token: tokenData.token,
      });
    } catch (error) {
      setRoomState("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while connecting to LiveKit."
      );
    }
  }

  function disconnectLiveKit() {
    setRoomDetails(null);
    setRoomState("idle");
  }

  return (
    <LiveKitRoom
      serverUrl={roomDetails?.serverUrl}
      token={roomDetails?.token}
      connect={!!roomDetails}
      audio={true}
      onConnected={() => setRoomState("connected")}
      onDisconnected={() => {
        setRoomState("idle");
        setRoomDetails(null);
      }}
    >
      <RoomAudioRenderer />
      <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.2),_transparent_30%),linear-gradient(180deg,_#113c66_0%,_#0a1d2f_50%,_#07111a_100%)] text-slate-50">
        <div className="relative flex min-h-screen flex-col">

        <section className="flex min-h-screen flex-1">
          <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0">
              <Tldraw onMount={setEditor} autoFocus />
            </div>
          </div>

          <aside className="hidden w-[380px] shrink-0 border-l border-white/10 bg-slate-950/62 p-4 backdrop-blur xl:flex xl:flex-col">
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/70">
                Realtime status
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                This shell is now aligned with the actual product direction:
                LiveKit for room transport, backend-issued tokens, and backend
                audio conversion before Gemini Live.
              </p>
            </div>

            <div className="mt-4 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                Session readiness
              </p>

              {status === "error" ? (
                <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100">
                  {errorMessage}
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
                    <p className="font-medium text-white">Board sync</p>
                    <p className="mt-1">
                      {syncState === "syncing"
                        ? "Syncing board changes to backend..."
                        : snapshot
                          ? `Last synced at ${new Date(snapshot.synced_at).toLocaleTimeString()}`
                          : "Waiting for first board change."}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Live board metrics</p>
                    <p className="mt-1">{boardMetrics.summary}</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-4 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                LiveKit setup
              </p>
              {realtimeConfig ? (
                <div className="mt-4 space-y-4 text-sm leading-6 text-slate-200">
                  <div>
                    <p className="font-medium text-white">Configured</p>
                    <p className="mt-1">
                      {realtimeConfig.configured
                        ? `Yes${realtimeConfig.livekit_url ? `, ${realtimeConfig.livekit_url}` : ""}`
                        : "No. Add backend LiveKit credentials to enable room connection."}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Audio pipeline</p>
                    <p className="mt-1">
                      LiveKit transport: {realtimeConfig.livekit_audio_hz} Hz
                      → Gemini input: {realtimeConfig.gemini_input_hz} Hz →
                      Gemini output: {realtimeConfig.gemini_output_hz} Hz →
                      back to LiveKit.
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Conversion boundary</p>
                    <p className="mt-1">
                      {realtimeConfig.backend_conversion_boundary}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Notes</p>
                    <ul className="mt-2 list-disc space-y-2 pl-5 text-slate-300">
                      {realtimeConfig.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex-1 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                Room connection
              </p>
              <div className="mt-4 space-y-4 text-sm leading-6 text-slate-200">
                <div>
                  <p className="font-medium text-white">State</p>
                  <p className="mt-1">
                    {roomState === "connected"
                      ? "Connected to LiveKit room."
                      : roomState === "connecting"
                        ? "Connecting to LiveKit..."
                        : roomState === "error"
                          ? "LiveKit connection failed."
                          : "Not connected yet."}
                  </p>
                </div>
                {roomDetails ? (
                  <>
                    <div>
                      <p className="font-medium text-white">Room</p>
                      <p className="mt-1">{roomDetails.roomName}</p>
                    </div>
                    <div>
                      <p className="font-medium text-white">Participant</p>
                      <p className="mt-1">{roomDetails.participantIdentity}</p>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </aside>
        </section>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4 md:px-6 md:pb-6">
          <div className="pointer-events-auto mx-auto max-w-xl rounded-[30px] border border-white/10 bg-slate-950/70 px-4 py-3 shadow-[0_24px_80px_rgba(3,8,20,0.45)] backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-slate-300">
                {boardMetrics.summary}
              </div>
              {roomState === "connected" ? (
                <div className="flex items-center gap-3" data-lk-theme="default">
                  <VoiceAssistantControlBar />
                  <button
                    className="rounded-full border border-rose-300/30 bg-rose-400/10 px-4 py-2 text-sm font-semibold text-rose-100"
                    onClick={disconnectLiveKit}
                    type="button"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    roomState === "connecting" || !realtimeConfig?.configured
                  }
                  onClick={connectLiveKit}
                  type="button"
                >
                  {roomState === "connecting" ? "Connecting..." : "Connect LiveKit"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
    </LiveKitRoom>
  );
}
