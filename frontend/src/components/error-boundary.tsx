"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level error boundary for the Tablo workspace.
 *
 * Catches unhandled React render errors (tldraw crashes, LiveKit failures,
 * etc.) and shows a recovery UI instead of a blank white screen.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[Tablo] Unhandled render error:", error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    const msg = this.state.error?.message ?? "Unknown error";

    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(180deg, #113c66 0%, #0a1d2f 50%, #07111a 100%)",
          fontFamily: "system-ui, sans-serif",
          color: "#e2e8f0",
          padding: "24px",
        }}
      >
        <div
          style={{
            maxWidth: "480px",
            width: "100%",
            padding: "40px 32px",
            borderRadius: "24px",
            border: "1px solid rgba(248,113,113,0.2)",
            background: "rgba(248,113,113,0.06)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "40px", marginBottom: "16px" }}>⚠️</div>
          <h2
            style={{
              margin: "0 0 8px",
              fontSize: "20px",
              fontWeight: 700,
              color: "#fff",
            }}
          >
            Something went wrong
          </h2>
          <p
            style={{
              margin: "0 0 24px",
              fontSize: "13px",
              color: "rgba(255,255,255,0.5)",
              lineHeight: 1.6,
            }}
          >
            The workspace encountered an unexpected error. Your board data is
            safe — this is a display issue.
          </p>

          {/* Error detail (collapsible) */}
          <details
            style={{
              marginBottom: "24px",
              textAlign: "left",
              background: "rgba(0,0,0,0.3)",
              borderRadius: "8px",
              padding: "10px 14px",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                fontSize: "12px",
                color: "rgba(255,255,255,0.4)",
                userSelect: "none",
              }}
            >
              Error details
            </summary>
            <pre
              style={{
                marginTop: "8px",
                fontSize: "11px",
                color: "#f87171",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "monospace",
              }}
            >
              {msg}
            </pre>
          </details>

          <button
            onClick={this.handleReload}
            style={{
              padding: "12px 28px",
              borderRadius: "10px",
              border: "none",
              background: "rgba(56,189,248,0.8)",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload workspace
          </button>
        </div>
      </main>
    );
  }
}
