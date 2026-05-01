"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Configure PDF.js worker — CDN avoids Turbopack bundler issues
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocumentMeta {
  doc_id: string;
  name: string;
  chunk_count: number;
}

export interface NavigationTarget {
  doc_name: string;
  page_number: number | null;
  text_excerpt: string | null;
}

export interface LearnerSelection {
  text: string;
  doc_name: string;
  page_number: number | null;
}

interface DocumentViewerPanelProps {
  documents: DocumentMeta[];
  activeNavigation: NavigationTarget | null;
  isConnected: boolean;
  onLearnerSelection: (selection: LearnerSelection) => void;
  onRefreshDocuments: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FORMAT_ICONS: Record<string, string> = {
  pdf: "📄", txt: "📝", docx: "📃", doc: "📃", pptx: "📊",
  rtf: "📝", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", webp: "🖼️",
  heif: "🖼️", xlsx: "📊", xls: "📊", csv: "📊", tsv: "📊",
  html: "🌐", hwp: "📃",
};

type ViewerType = "pdf" | "image" | "text" | "html";

function getExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function getViewerType(name: string): ViewerType {
  const ext = getExt(name);
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "heif"].includes(ext)) return "image";
  if (ext === "html") return "html";
  return "text";
}

function getFormatIcon(name: string): string {
  return FORMAT_ICONS[getExt(name)] ?? "📄";
}

function displayName(name: string): string {
  const match = name.match(/^[a-f0-9]{32}_(.+)$/);
  return match ? match[1] : name;
}

// ─── Selection tooltip ────────────────────────────────────────────────────────
// Floats near the user's text selection and lets them send it to the AI
// without any persistent button cluttering the UI.

interface SelectionTooltipProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSend: (text: string) => void;
}

function SelectionTooltip({ containerRef, onSend }: SelectionTooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedText, setSelectedText] = useState("");

  useEffect(() => {
    function handleSelectionChange() {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";

      if (!text || !sel || sel.rangeCount === 0) {
        setPos(null);
        setSelectedText("");
        return;
      }

      // Only show if selection is inside our container
      const container = containerRef.current;
      if (!container) return;
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setPos(null);
        setSelectedText("");
        return;
      }

      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setPos({
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top - containerRect.top - 8,
      });
      setSelectedText(text);
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [containerRef]);

  if (!pos || !selectedText) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        transform: "translate(-50%, -100%)",
        background: "rgba(56,189,248,0.95)",
        color: "#0c1a2e",
        borderRadius: "6px",
        padding: "4px 10px",
        fontSize: "11px",
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
        zIndex: 500,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        pointerEvents: "auto",
      }}
      onMouseDown={(e) => {
        e.preventDefault(); // don't clear selection
        onSend(selectedText);
        window.getSelection()?.removeAllRanges();
        setPos(null);
        setSelectedText("");
      }}
    >
      Ask AI about this ↑
    </div>
  );
}

// ─── PDF Viewer ───────────────────────────────────────────────────────────────

interface PdfViewerProps {
  fileUrl: string;
  targetPage: number;
  highlight: string | null;
  onSelection: (text: string) => void;
}

function PdfViewer({ fileUrl, targetPage, highlight, onSelection }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(targetPage);
  const [containerWidth, setContainerWidth] = useState<number>(356);
  const containerRef = useRef<HTMLDivElement>(null);

  // Update container width on resize
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth || 356);
      }
    };
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  // Jump to page when AI navigates - use functional update to avoid direct setState in effect
  useEffect(() => {
    if (targetPage >= 1 && (numPages === 0 || targetPage <= numPages)) {
      setCurrentPage(() => Math.max(1, Math.min(targetPage, numPages || targetPage)));
    }
  }, [targetPage, numPages]);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setCurrentPage((p) => Math.min(Math.max(p, 1), numPages));
  }

  // Highlight AI-referenced text in the PDF text layer
  const customTextRenderer = useCallback(
    (textItem: { str: string }) => {
      if (!highlight) return textItem.str;
      // Try to find any substring of the highlight that matches (handles chunked text items)
      const needle = highlight.slice(0, 40); // first 40 chars is enough to locate
      const idx = textItem.str.indexOf(needle);
      if (idx === -1) return textItem.str;
      return (
        textItem.str.slice(0, idx) +
        `<mark style="background:rgba(250,204,21,0.45);color:inherit;border-radius:2px;padding:0 1px">${textItem.str.slice(idx, idx + needle.length)}</mark>` +
        textItem.str.slice(idx + needle.length)
      );
    },
    [highlight]
  );

  const canPrev = currentPage > 1;
  const canNext = currentPage < numPages;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Page nav */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "10px",
          padding: "5px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontSize: "12px",
          color: "rgba(255,255,255,0.6)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          disabled={!canPrev}
          style={navBtnStyle(canPrev)}
        >
          ‹
        </button>
        <span style={{ minWidth: "80px", textAlign: "center" }}>
          {currentPage} / {numPages || "…"}
        </span>
        <button
          onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
          disabled={!canNext}
          style={navBtnStyle(canNext)}
        >
          ›
        </button>
      </div>

      {/* PDF canvas — fills available width */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: "auto", position: "relative" }}
      >
        <SelectionTooltip containerRef={containerRef} onSend={onSelection} />
        <Document
          file={fileUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={<Spinner />}
          error={<LoadError />}
        >
          <Page
            pageNumber={currentPage}
            width={containerWidth - 2}
            renderAnnotationLayer={false}
            renderTextLayer
            customTextRenderer={customTextRenderer}
          />
        </Document>
      </div>
    </div>
  );
}

function navBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: "none",
    border: "1px solid rgba(255,255,255,0.2)",
    color: active ? "#e2e8f0" : "rgba(255,255,255,0.2)",
    borderRadius: "4px",
    width: "28px",
    height: "24px",
    cursor: active ? "pointer" : "default",
    fontSize: "16px",
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function Spinner() {
  return (
    <div style={{ color: "rgba(255,255,255,0.4)", padding: "24px", textAlign: "center", fontSize: "12px" }}>
      Loading…
    </div>
  );
}

function LoadError() {
  return (
    <div style={{ color: "#f87171", padding: "24px", textAlign: "center", fontSize: "12px" }}>
      Failed to load PDF.
    </div>
  );
}

// ─── Text Viewer ──────────────────────────────────────────────────────────────

interface TextViewerProps {
  docId: string;
  highlight: string | null;
  onSelection: (text: string) => void;
}

function TextViewer({ docId, highlight, onSelection }: TextViewerProps) {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/documents/${docId}/text`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (!controller.signal.aborted) { setText(d.text || "No content extracted."); setLoading(false); } })
      .catch(() => { if (!controller.signal.aborted) { setText("Failed to load document."); setLoading(false); } });
    return () => controller.abort();
  }, [docId]);

  if (loading) return <Spinner />;

  const renderContent = () => {
    if (highlight && text.includes(highlight)) {
      const parts = text.split(highlight);
      return parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && (
            <mark style={{ background: "rgba(250,204,21,0.35)", color: "#fef08a", borderRadius: "2px" }}>
              {highlight}
            </mark>
          )}
        </span>
      ));
    }
    return text;
  };

  return (
    <div ref={containerRef} style={{ position: "relative", height: "100%" }}>
      <SelectionTooltip containerRef={containerRef} onSend={onSelection} />
      <pre style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "system-ui, sans-serif",
        margin: 0,
        fontSize: "12px",
        lineHeight: 1.6,
        color: "#cbd5e1",
      }}>
        {renderContent()}
      </pre>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function DocumentViewerPanel({
  documents,
  activeNavigation,
  isConnected,
  onLearnerSelection,
  onRefreshDocuments,
}: DocumentViewerPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState<DocumentMeta | null>(null);
  const [targetPage, setTargetPage] = useState<number>(1);
  const [highlight, setHighlight] = useState<string | null>(null);

  // Auto-expand and navigate when AI references a source
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (!activeNavigation) return;
    setIsCollapsed(false);
    setHighlight(activeNavigation.text_excerpt ?? null);

    const match = documents.find(
      (d) =>
        d.name.includes(activeNavigation.doc_name) ||
        activeNavigation.doc_name.includes(displayName(d.name))
    );
    if (match) {
      if (match.doc_id !== selectedDoc?.doc_id) setSelectedDoc(match);
      if (activeNavigation.page_number != null) setTargetPage(activeNavigation.page_number);
    }
  }, [activeNavigation, documents]);

  // Reset when switching docs manually
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setTargetPage(1);
    setHighlight(null);
  }, [selectedDoc?.doc_id]);

  const handleSelection = useCallback(
    (text: string) => {
      if (!isConnected || !selectedDoc) return;
      onLearnerSelection({
        text,
        doc_name: displayName(selectedDoc.name),
        page_number: getViewerType(selectedDoc.name) === "pdf" ? targetPage : null,
      });
    },
    [isConnected, selectedDoc, targetPage, onLearnerSelection]
  );

  if (documents.length === 0 && isCollapsed) return null;

  const viewerType = selectedDoc ? getViewerType(selectedDoc.name) : null;
  const fileUrl = selectedDoc ? `${API_BASE_URL}/documents/${selectedDoc.doc_id}/file` : "";

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: isCollapsed ? "40px" : "380px",
        zIndex: 300,
        display: "flex",
        flexDirection: "column",
        transition: "width 0.2s ease",
        pointerEvents: "auto",
      }}
    >
      {/* Toggle tab */}
      <button
        onClick={() => setIsCollapsed((c) => !c)}
        style={{
          position: "absolute",
          left: "-32px",
          top: "50%",
          transform: "translateY(-50%)",
          background: "rgba(0,0,0,0.7)",
          color: "#fff",
          border: "none",
          borderRadius: "8px 0 0 8px",
          padding: "8px 6px",
          cursor: "pointer",
          fontSize: "14px",
          zIndex: 301,
        }}
        title={isCollapsed ? "Open document viewer" : "Close document viewer"}
      >
        {isCollapsed ? "📚" : "✕"}
      </button>

      {!isCollapsed && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: "rgba(10,20,35,0.97)",
            borderLeft: "1px solid rgba(255,255,255,0.1)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div style={sectionHeaderStyle}>
            Documents ({documents.length})
          </div>

          {/* Doc list */}
          <div
            style={{
              maxHeight: selectedDoc ? "108px" : "100%",
              overflowY: "auto",
              borderBottom: selectedDoc ? "1px solid rgba(255,255,255,0.08)" : "none",
              flexShrink: 0,
            }}
          >
            {documents.map((doc) => (
              <div
                key={doc.doc_id}
                onClick={() => setSelectedDoc(doc)}
                style={{
                  padding: "7px 12px",
                  cursor: "pointer",
                  background: selectedDoc?.doc_id === doc.doc_id ? "rgba(56,189,248,0.12)" : "transparent",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  fontSize: "12px",
                  color: "#e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>{getFormatIcon(doc.name)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {displayName(doc.name)}
                </span>
                <span style={{ color: "rgba(255,255,255,0.25)", fontSize: "10px" }}>
                  {doc.chunk_count}ch
                </span>
              </div>
            ))}
          </div>

          {/* Viewer */}
          {selectedDoc && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
              {/* Doc name bar */}
              <div style={{
                padding: "4px 12px",
                fontSize: "11px",
                color: "rgba(255,255,255,0.4)",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                flexShrink: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {displayName(selectedDoc.name)}
                {highlight && (
                  <span style={{ marginLeft: "6px", color: "#facc15", fontSize: "10px" }}>
                    ● AI source
                  </span>
                )}
                {isConnected && (
                  <span style={{ marginLeft: "6px", color: "rgba(56,189,248,0.6)", fontSize: "10px" }}>
                    · select text to ask AI
                  </span>
                )}
              </div>

              <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
                {viewerType === "pdf" && (
                  <PdfViewer
                    fileUrl={fileUrl}
                    targetPage={targetPage}
                    highlight={highlight}
                    onSelection={handleSelection}
                  />
                )}
                {viewerType === "image" && (
                  <div style={{ overflow: "auto", height: "100%", padding: "8px" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl} alt={displayName(selectedDoc.name)} style={{ maxWidth: "100%", borderRadius: "4px" }} />
                  </div>
                )}
                {viewerType === "html" && (
                  <iframe
                    src={fileUrl}
                    sandbox="allow-same-origin"
                    style={{ width: "100%", height: "100%", border: "none" }}
                    title={displayName(selectedDoc.name)}
                  />
                )}
                {viewerType === "text" && (
                  <div style={{ overflow: "auto", height: "100%", padding: "12px" }}>
                    <TextViewer docId={selectedDoc.doc_id} highlight={highlight} onSelection={handleSelection} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "rgba(255,255,255,0.4)",
  flexShrink: 0,
};
