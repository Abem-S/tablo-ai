"use client";

import { useRef, useState } from "react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

interface UploadedDoc {
  doc_id: string;
  name: string;
  chunk_count: number;
  status: string;
}

export function DocumentUploadButton({ 
  authHeaders = {}, 
  sessionId 
}: { 
  authHeaders?: Record<string, string>;
  sessionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/documents`, { headers: authHeaders });
      if (res.ok) setDocs(await res.json());
    } catch {
      // non-fatal
    }
  };

  const handleOpen = () => {
    setOpen((o) => !o);
    if (!open) fetchDocs();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      // Add session_id to form if provided
      if (sessionId) {
        form.append("session_id", sessionId);
      }
      const res = await fetch(`${API_BASE_URL}/documents/upload?session_id=${encodeURIComponent(sessionId || "")}`, {
        method: "POST",
        headers: authHeaders,
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Upload failed (${res.status})`);
      }
      const result: UploadedDoc = await res.json();
      if (result.status === "failed") {
        throw new Error(result.chunk_count === 0 ? "Ingestion failed — check backend logs" : `Ingestion failed: ${result.status}`);
      }
      setDocs((prev) => [result, ...prev]);

      // Poll for ingestion completion
      if (result.status === "processing") {
        const docId = result.doc_id;
        const poll = async () => {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const statusRes = await fetch(`${API_BASE_URL}/documents/${docId}/status`, {
                headers: authHeaders,
              });
              if (!statusRes.ok) break;
              const statusData = await statusRes.json();
              setDocs((prev) =>
                prev.map((d) =>
                  d.doc_id === docId
                    ? { ...d, chunk_count: statusData.chunk_count, status: statusData.status }
                    : d
                )
              );
              if (statusData.status !== "processing") break;
            } catch { break; }
          }
        };
        void poll();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      // Reset input so same file can be re-uploaded
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (docId: string) => {
    try {
      await fetch(`${API_BASE_URL}/documents/${docId}`, { method: "DELETE", headers: authHeaders });
      setDocs((prev) => prev.filter((d) => d.doc_id !== docId));
    } catch {
      // non-fatal
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {/* Trigger button */}
      <button
        onClick={handleOpen}
        title="Upload source documents"
        style={{
          background: open ? "rgba(239, 112, 96, 0.2)" : "rgba(239, 112, 96, 0.1)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: "50%",
          width: "36px",
          height: "36px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          color: "#fff",
          fontSize: "16px",
          flexShrink: 0,
        }}
        type="button"
      >
        📄
      </button>

      {/* Popover */}
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "48px",
            right: 0,
            width: "280px",
            background: "rgba(10,20,35,0.95)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "14px",
            padding: "14px",
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
            zIndex: 500,
            fontFamily: "system-ui, sans-serif",
            fontSize: "12px",
            color: "#e2e8f0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <span style={{ fontWeight: 600, fontSize: "13px" }}>Source Documents</span>
            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "11px" }}>All formats</span>
          </div>

          {/* Upload button */}
          <label
            style={{
              display: "block",
              textAlign: "center",
              padding: "8px",
              borderRadius: "8px",
              border: "1px dashed rgba(255,255,255,0.2)",
              cursor: uploading ? "not-allowed" : "pointer",
              color: uploading ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.7)",
              marginBottom: "10px",
              transition: "background 0.15s",
            }}
          >
            {uploading ? "Uploading…" : "+ Add document"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.docx,.doc,.pptx,.rtf,.png,.jpg,.jpeg,.webp,.heif,.xlsx,.xls,.csv,.tsv,.html,.hwp"
              style={{ display: "none" }}
              onChange={handleFileChange}
              disabled={uploading}
            />
          </label>

          {error && (
            <div style={{ color: "#f87171", marginBottom: "8px", fontSize: "11px" }}>
              {error}
            </div>
          )}

          {/* Document list */}
          {docs.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.35)", textAlign: "center", padding: "8px 0" }}>
              No documents yet
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "180px", overflowY: "auto" }}>
              {docs.map((doc) => (
                <div
                  key={doc.doc_id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "6px 8px",
                    borderRadius: "8px",
                    background: "rgba(255,255,255,0.05)",
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {doc.name}
                  </span>
                  <span style={{ color: "rgba(255,255,255,0.35)", flexShrink: 0 }}>
                    {doc.status === "processing"
                      ? "⏳ indexing…"
                      : doc.status === "failed"
                      ? "❌ failed"
                      : `${doc.chunk_count} chunks`}
                  </span>
                  <button
                    onClick={() => handleDelete(doc.doc_id)}
                    title="Remove document"
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(255,100,100,0.6)",
                      cursor: "pointer",
                      fontSize: "13px",
                      padding: "0 2px",
                      flexShrink: 0,
                    }}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
