"use client";

import { useState } from "react";

// -----------------------------------------------------------------------
// Types — must match the tutor.sources wire format from the backend
// -----------------------------------------------------------------------

export interface SourceAttribution {
  chunk_id: string;
  document_name: string;
  page_number: number | null;
  section_title: string | null;
  text_excerpt: string;
  relevance: "high" | "supplementary";
  score: number;
}

export interface SourcesPayload {
  turn_id: string;
  is_general_knowledge: boolean;
  sources: SourceAttribution[];
}

// -----------------------------------------------------------------------
// SourcePanel component
// -----------------------------------------------------------------------

interface SourcePanelProps {
  sources: SourceAttribution[];
  isGeneralKnowledge: boolean;
}

export function SourcePanel({ sources, isGeneralKnowledge }: SourcePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);

  if (dismissed) return null;

  const toggleExpand = (chunkId: string) => {
    setExpandedChunkId((prev) => (prev === chunkId ? null : chunkId));
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: "72px", // above VoiceAssistantControlBar
        right: "12px",
        zIndex: 400, // below tldraw UI (500+) but above canvas
        maxWidth: "280px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "12px",
        pointerEvents: "auto",
      }}
    >
      {/* Header pill */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "rgba(0,0,0,0.72)",
          color: "#fff",
          borderRadius: collapsed ? "20px" : "10px 10px 0 0",
          padding: "5px 10px",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span style={{ fontSize: "10px" }}>{collapsed ? "▲" : "▼"}</span>
        <span style={{ fontWeight: 600, letterSpacing: "0.02em" }}>
          {isGeneralKnowledge ? "💡 General knowledge" : `📚 ${sources.length} source${sources.length !== 1 ? "s" : ""}`}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.6)",
            cursor: "pointer",
            fontSize: "13px",
            lineHeight: 1,
            padding: "0 2px",
          }}
          aria-label="Dismiss source panel"
        >
          ×
        </button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div
          style={{
            background: "rgba(0,0,0,0.82)",
            borderRadius: "0 0 10px 10px",
            overflow: "hidden",
            maxHeight: "260px",
            overflowY: "auto",
          }}
        >
          {isGeneralKnowledge || sources.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.55)", padding: "8px 10px" }}>
              Responding from general knowledge — no documents matched.
            </div>
          ) : (
            sources.map((src) => (
              <SourceEntry
                key={src.chunk_id}
                source={src}
                expanded={expandedChunkId === src.chunk_id}
                onToggle={() => toggleExpand(src.chunk_id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Individual source entry
// -----------------------------------------------------------------------

interface SourceEntryProps {
  source: SourceAttribution;
  expanded: boolean;
  onToggle: () => void;
}

function SourceEntry({ source, expanded, onToggle }: SourceEntryProps) {
  const locationParts: string[] = [];
  if (source.page_number) locationParts.push(`p.${source.page_number}`);
  if (source.section_title) locationParts.push(source.section_title);
  const location = locationParts.join(" · ");

  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.08)",
        padding: "7px 10px",
        cursor: "pointer",
      }}
      onClick={onToggle}
    >
      {/* Compact row */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: source.relevance === "high" ? "#4ade80" : "#facc15",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: "#fff",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {source.document_name}
        </span>
        {location && (
          <span style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0 }}>
            {location}
          </span>
        )}
        <span style={{ color: "rgba(255,255,255,0.35)", flexShrink: 0 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Expanded excerpt */}
      {expanded && (
        <div
          style={{
            marginTop: "6px",
            color: "rgba(255,255,255,0.75)",
            lineHeight: 1.5,
            fontSize: "11px",
            borderLeft: "2px solid rgba(255,255,255,0.15)",
            paddingLeft: "8px",
          }}
        >
          {source.text_excerpt}
        </div>
      )}
    </div>
  );
}
