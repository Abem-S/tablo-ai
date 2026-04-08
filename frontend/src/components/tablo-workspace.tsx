"use client";

import { useEffect, useRef, useState } from "react";
import { Tldraw, type Editor } from "tldraw";
import { toRichText } from "@tldraw/tlschema";
import { LiveKitRoom, RoomAudioRenderer, VoiceAssistantControlBar, useRoomContext } from "@livekit/components-react";
import { LocalVideoTrack, Track } from "livekit-client";
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

type BoardTargetRef =
  | { kind: "selection"; index?: number }
  | { kind: "pointer" }
  | { kind: "this" }
  | { kind: "that" }
  | { kind: "shape_id"; shapeId: string };

type BoardCommand =
  | {
      v: number;
      id: string;
      op: "create_text";
      text: string;
      x: number;
      y: number;
    }
  | {
      v: number;
      id: string;
      op: "create_text_near_selection";
      text: string;
      offsetX?: number;
      offsetY?: number;
    }
  | {
      v: number;
      id: string;
      op: "create_geo";
      geo: "rectangle" | "ellipse" | "diamond" | "triangle";
      x: number;
      y: number;
      w: number;
      h: number;
      label?: string;
    }
  | {
      v: number;
      id: string;
      op: "create_arrow";
      x: number;
      y: number;
      toX: number;
      toY: number;
    }
  | {
      v: number;
      id: string;
      op: "create_text_on_target";
      text: string;
      target: BoardTargetRef;
      placement?: "center" | "top" | "bottom" | "left" | "right";
      offset?: number;
    }
  | {
      v: number;
      id: string;
      op: "create_arrow_between_targets";
      from: BoardTargetRef;
      to: BoardTargetRef;
      label?: string;
    };

type CreateShapeInput = Parameters<Editor["createShape"]>[0];

type PageRect = { x: number; y: number; w: number; h: number };

type BoardTargetState = {
  lastPointerPagePoint: { x: number; y: number } | null;
  pointerShapeId: string | null;
  thisShapeId: string | null;
  thatShapeId: string | null;
};

function updateFocusHistory(state: BoardTargetState, shapeId: string | null) {
  if (!shapeId || state.thisShapeId === shapeId) {
    return;
  }

  state.thatShapeId = state.thisShapeId;
  state.thisShapeId = shapeId;
}

function getShapeBounds(editor: Editor, shapeId: string): PageRect | null {
  const shape = editor.getShape(shapeId);
  if (!shape) return null;

  const bounds = editor.getShapePageBounds(shape);
  if (!bounds) return null;

  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
}

function getRectCenter(rect: PageRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function getEdgePointTowards(rect: PageRect, towards: { x: number; y: number }) {
  const center = getRectCenter(rect);
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;

  if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) {
    return center;
  }

  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (rect.w / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (rect.h / 2) / Math.abs(dy);
  const t = Math.min(scaleX, scaleY);

  return {
    x: center.x + dx * t,
    y: center.y + dy * t,
  };
}

function getPlacementPoint(
  rect: PageRect,
  placement: "center" | "top" | "bottom" | "left" | "right",
  offset: number
) {
  const center = getRectCenter(rect);

  switch (placement) {
    case "center":
      return center;
    case "top":
      return { x: center.x, y: rect.y - offset };
    case "bottom":
      return { x: center.x, y: rect.y + rect.h + offset };
    case "left":
      return { x: rect.x - offset, y: center.y };
    case "right":
      return { x: rect.x + rect.w + offset, y: center.y };
    default:
      return { x: center.x, y: rect.y - offset };
  }
}

function resolveTargetShapeId(
  editor: Editor,
  target: BoardTargetRef,
  targetState: BoardTargetState
): string | null {
  switch (target.kind) {
    case "shape_id":
      return editor.getShape(target.shapeId) ? target.shapeId : null;
    case "selection": {
      const selection = editor.getSelectedShapeIds();
      if (selection.length === 0) return null;
      const index =
        typeof target.index === "number" && Number.isInteger(target.index)
          ? Math.max(0, Math.min(target.index, selection.length - 1))
          : 0;
      return selection[index] ?? null;
    }
    case "pointer": {
      if (targetState.pointerShapeId && editor.getShape(targetState.pointerShapeId)) {
        return targetState.pointerShapeId;
      }

      const pointer = targetState.lastPointerPagePoint;
      if (!pointer) return null;
      const hit = editor.getShapeAtPoint(pointer, {
        hitInside: true,
        hitLabels: true,
        renderingOnly: true,
      });
      return hit?.id ?? null;
    }
    case "this":
      return targetState.thisShapeId && editor.getShape(targetState.thisShapeId)
        ? targetState.thisShapeId
        : null;
    case "that":
      return targetState.thatShapeId && editor.getShape(targetState.thatShapeId)
        ? targetState.thatShapeId
        : null;
    default:
      return null;
  }
}

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

function applyBoardCommand(
  editor: Editor,
  command: BoardCommand,
  targetState: BoardTargetState
): void {
  try {
    switch (command.op) {
      case "create_text": {
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
          console.warn("Skipping invalid text command", command);
          break;
        }

        editor.createShape({
          type: "text",
          x: command.x,
          y: command.y,
          props: {
            richText: toRichText(command.text),
          },
        } as unknown as CreateShapeInput);
        break;
      }
      case "create_text_near_selection": {
        const bounds = editor.getSelectionPageBounds();
        if (!bounds) {
          console.warn("Skipping create_text_near_selection with no selection", command);
          break;
        }

        const offsetX =
          typeof command.offsetX === "number" && Number.isFinite(command.offsetX)
            ? command.offsetX
            : 0;
        const offsetY =
          typeof command.offsetY === "number" && Number.isFinite(command.offsetY)
            ? command.offsetY
            : 0;
        const anchorX = bounds.x + bounds.w / 2 + offsetX;
        const anchorY = bounds.y + bounds.h / 2 + offsetY;

        editor.createShape({
          type: "text",
          x: anchorX,
          y: anchorY,
          props: {
            richText: toRichText(command.text),
          },
        } as unknown as CreateShapeInput);
        break;
      }
      case "create_geo": {
        if (
          !Number.isFinite(command.x) ||
          !Number.isFinite(command.y) ||
          !Number.isFinite(command.w) ||
          !Number.isFinite(command.h)
        ) {
          console.warn("Skipping invalid geo command", command);
          break;
        }

        editor.createShape({
          type: "geo",
          x: command.x,
          y: command.y,
          props: {
            geo: command.geo,
            w: Math.max(command.w, 40),
            h: Math.max(command.h, 40),
            richText: toRichText(command.label ?? ""),
          },
        } as unknown as CreateShapeInput);
        break;
      }
      case "create_arrow": {
        const dx = command.toX - command.x;
        const dy = command.toY - command.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
          console.warn("Skipping invalid arrow command", command);
          break;
        }

        editor.createShape({
          type: "arrow",
          x: command.x,
          y: command.y,
          props: {
            start: { x: 0, y: 0 },
            end: { x: dx, y: dy },
            richText: toRichText(""),
          },
        } as unknown as CreateShapeInput);
        break;
      }
      case "create_text_on_target": {
        const targetShapeId = resolveTargetShapeId(editor, command.target, targetState);
        if (!targetShapeId) {
          console.warn("Skipping create_text_on_target, unresolved target", command);
          break;
        }

        const targetBounds = getShapeBounds(editor, targetShapeId);
        if (!targetBounds) {
          console.warn("Skipping create_text_on_target, missing target bounds", command);
          break;
        }

        updateFocusHistory(targetState, targetShapeId);

        const placement = command.placement ?? "top";
        const offset =
          typeof command.offset === "number" && Number.isFinite(command.offset)
            ? Math.max(0, command.offset)
            : 24;
        const anchor = getPlacementPoint(targetBounds, placement, offset);

        editor.createShape({
          type: "text",
          x: anchor.x,
          y: anchor.y,
          props: {
            richText: toRichText(command.text),
          },
        } as unknown as CreateShapeInput);
        break;
      }
      case "create_arrow_between_targets": {
        const fromShapeId = resolveTargetShapeId(editor, command.from, targetState);
        const toShapeId = resolveTargetShapeId(editor, command.to, targetState);

        if (!fromShapeId || !toShapeId) {
          console.warn("Skipping create_arrow_between_targets, unresolved target", command);
          break;
        }

        const fromBounds = getShapeBounds(editor, fromShapeId);
        const toBounds = getShapeBounds(editor, toShapeId);

        if (!fromBounds || !toBounds) {
          console.warn("Skipping create_arrow_between_targets, missing target bounds", command);
          break;
        }

        updateFocusHistory(targetState, fromShapeId);
        updateFocusHistory(targetState, toShapeId);

        const fromCenter = getRectCenter(fromBounds);
        const toCenter = getRectCenter(toBounds);
        const start = getEdgePointTowards(fromBounds, toCenter);
        const end = getEdgePointTowards(toBounds, fromCenter);
        const dx = end.x - start.x;
        const dy = end.y - start.y;

        editor.createShape({
          type: "arrow",
          x: start.x,
          y: start.y,
          props: {
            start: { x: 0, y: 0 },
            end: { x: dx, y: dy },
            richText: toRichText(""),
          },
        } as unknown as CreateShapeInput);

        if (command.label) {
          editor.createShape({
            type: "text",
            x: start.x + dx / 2,
            y: start.y + dy / 2 - 16,
            props: {
              richText: toRichText(command.label),
            },
          } as unknown as CreateShapeInput);
        }
        break;
      }
      default:
        console.warn("Unsupported board command", command);
    }
  } catch (error) {
    console.error("Error applying board command:", error, command);
  }
}

function mapPagePointToVideo(
  pagePoint: { x: number; y: number },
  pageBounds: PageRect,
  padding: number,
  targetRect: { x: number; y: number; w: number; h: number }
): { x: number; y: number } {
  const exportW = Math.max(pageBounds.w + padding * 2, 1);
  const exportH = Math.max(pageBounds.h + padding * 2, 1);
  const px = (pagePoint.x - pageBounds.x + padding) * (targetRect.w / exportW);
  const py = (pagePoint.y - pageBounds.y + padding) * (targetRect.h / exportH);
  return {
    x: targetRect.x + px,
    y: targetRect.y + py,
  };
}

function CanvasVideoPublisher({
  isConnected,
  editor,
}: {
  isConnected: boolean;
  editor: Editor | null;
}) {
  const room = useRoomContext();
  const timerRef = useRef<number | null>(null);
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);

  useEffect(() => {
    if (!isConnected || !editor) return;

    let cancelled = false;

    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = 1280;
    offscreenCanvas.height = 720;
    const drawCtx = offscreenCanvas.getContext("2d");

    if (!drawCtx) {
      console.error("Unable to create offscreen canvas context for board video");
      return;
    }

    drawCtx.fillStyle = "#0b1220";
    drawCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

    const stream = offscreenCanvas.captureStream(2);
    const mediaTrack = stream.getVideoTracks()[0];

    if (!mediaTrack) {
      console.error("No media track produced from board capture stream");
      return;
    }

    const localVideoTrack = new LocalVideoTrack(mediaTrack);
    localVideoTrackRef.current = localVideoTrack;

    void room.localParticipant
      .publishTrack(localVideoTrack, {
        source: Track.Source.Camera,
        simulcast: false,
      })
      .then(() => {
        console.log("Published live board video track");
      })
      .catch((error) => {
        console.error("Failed to publish board video track", error);
      });

    const renderBoardFrame = async () => {
      try {
        const pageShapeIds = [...editor.getCurrentPageShapeIds()];
        const exportPadding = 64;
        const imageResult = await editor.toImage(pageShapeIds, {
          format: "png",
          background: true,
          preserveAspectRatio: "contain",
          padding: exportPadding,
          scale: 1,
        });

        if (cancelled) return;

        const bitmap = await createImageBitmap(imageResult.blob);
        drawCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
        drawCtx.fillStyle = "#0b1220";
        drawCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

        const scale = Math.min(
          offscreenCanvas.width / bitmap.width,
          offscreenCanvas.height / bitmap.height
        );
        const targetW = bitmap.width * scale;
        const targetH = bitmap.height * scale;
        const targetX = (offscreenCanvas.width - targetW) / 2;
        const targetY = (offscreenCanvas.height - targetH) / 2;

        drawCtx.drawImage(bitmap, targetX, targetY, targetW, targetH);

        const pageBounds = editor.getCurrentPageBounds();
        if (pageBounds) {
          const normalizedBounds: PageRect = {
            x: pageBounds.x,
            y: pageBounds.y,
            w: pageBounds.w,
            h: pageBounds.h,
          };

          const targetRect = { x: targetX, y: targetY, w: targetW, h: targetH };

          const selection = editor.getSelectionPageBounds();
          if (selection) {
            const topLeft = mapPagePointToVideo(
              { x: selection.x, y: selection.y },
              normalizedBounds,
              exportPadding,
              targetRect
            );
            const bottomRight = mapPagePointToVideo(
              { x: selection.x + selection.w, y: selection.y + selection.h },
              normalizedBounds,
              exportPadding,
              targetRect
            );

            drawCtx.save();
            drawCtx.strokeStyle = "#22d3ee";
            drawCtx.lineWidth = 3;
            drawCtx.setLineDash([10, 6]);
            drawCtx.strokeRect(
              topLeft.x,
              topLeft.y,
              Math.max(1, bottomRight.x - topLeft.x),
              Math.max(1, bottomRight.y - topLeft.y)
            );
            drawCtx.restore();
          }

          const pointer = editor.inputs.getCurrentPagePoint();
          const pointerVideo = mapPagePointToVideo(
            { x: pointer.x, y: pointer.y },
            normalizedBounds,
            exportPadding,
            targetRect
          );

          drawCtx.save();
          drawCtx.fillStyle = "#f97316";
          drawCtx.beginPath();
          drawCtx.arc(pointerVideo.x, pointerVideo.y, 7, 0, Math.PI * 2);
          drawCtx.fill();
          drawCtx.strokeStyle = "#fff";
          drawCtx.lineWidth = 2;
          drawCtx.stroke();
          drawCtx.restore();
        }

        bitmap.close();
      } catch (error) {
        console.error("Failed to render board video frame", error);
      }
    };

    void renderBoardFrame();
    timerRef.current = window.setInterval(() => {
      void renderBoardFrame();
    }, 200);

    return () => {
      cancelled = true;

      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }

      const localTrack = localVideoTrackRef.current;
      localVideoTrackRef.current = null;

      if (localTrack) {
        void room.localParticipant.unpublishTrack(localTrack);
        localTrack.stop();
      }

      stream.getTracks().forEach((track) => track.stop());
    };
  }, [editor, isConnected, room]);

  return null; // This component has no UI
}

function BoardCommandBridge({
  isConnected,
  editor,
  targetStateRef,
}: {
  isConnected: boolean;
  editor: Editor | null;
  targetStateRef: { current: BoardTargetState };
}) {
  const room = useRoomContext();

  useEffect(() => {
    if (!isConnected || !editor) return;

    const onDataReceived = (
      payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== "board.command") return;

      try {
        const command = JSON.parse(
          new TextDecoder().decode(payload)
        ) as BoardCommand;
        applyBoardCommand(editor, command, targetStateRef.current);
      } catch (error) {
        console.error("Failed to apply board command", error);
      }
    };

    room.on("dataReceived", onDataReceived);
    return () => {
      room.off("dataReceived", onDataReceived);
    };
  }, [editor, isConnected, room, targetStateRef]);

  return null;
}

export function TabloWorkspace() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const targetStateRef = useRef<BoardTargetState>({
    lastPointerPagePoint: null,
    pointerShapeId: null,
    thisShapeId: null,
    thatShapeId: null,
  });
  const [session, setSession] = useState<SessionBootstrap | null>(null);
  const [boardMetrics, setBoardMetrics] = useState<BoardMetrics>(() =>
    getBoardMetrics(null)
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
        setBoardMetrics(getBoardMetrics(editor));
        // The Gemini model now sees the board through published PNG snapshots.
      },
      { source: "user", scope: "document" }
    );

    return () => {
      removeListener();
    };
  }, [editor, session]);

  useEffect(() => {
    if (!editor) return;

    const targetState = targetStateRef.current;

    const updateFromSelection = () => {
      const selected = editor.getSelectedShapeIds();
      if (selected.length > 0) {
        updateFocusHistory(targetState, selected[0] ?? null);
      }
    };

    const removeSelectionListener = editor.store.listen(
      () => {
        updateFromSelection();
      },
      { source: "user", scope: "document" }
    );

    updateFromSelection();

    const interval = window.setInterval(() => {
      const pointer = editor.inputs.getCurrentPagePoint();
      targetState.lastPointerPagePoint = { x: pointer.x, y: pointer.y };

      const hoverShape = editor.getShapeAtPoint(pointer, {
        hitInside: true,
        hitLabels: true,
        renderingOnly: true,
      });

      const hoverId = hoverShape?.id ?? null;
      targetState.pointerShapeId = hoverId;
      updateFocusHistory(targetState, hoverId);
    }, 120);

    return () => {
      removeSelectionListener();
      window.clearInterval(interval);
    };
  }, [editor]);

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
      <CanvasVideoPublisher isConnected={roomState === "connected"} editor={editor} />
      <BoardCommandBridge
        isConnected={roomState === "connected"}
        editor={editor}
        targetStateRef={targetStateRef}
      />
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
                LiveKit for room transport, backend-issued tokens, and live
                vision input before Gemini Live.
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
                    <p className="font-medium text-white">Vision feed</p>
                    <p className="mt-1">
                      The board is streamed as a live video track into the room
                      so Gemini receives ongoing visual context.
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
