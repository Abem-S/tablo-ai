"use client";

import { useState } from "react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

interface LockScreenProps {
  onUnlocked: (token: string) => void;
}

export function LockScreen({ onUnlocked }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Incorrect password");
      }
      const data = await res.json();
      // Persist token in sessionStorage so it survives page refreshes
      sessionStorage.setItem("tablo_token", data.token);
      onUnlocked(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at top left, rgba(255,255,255,0.2), transparent 30%), linear-gradient(180deg, #113c66 0%, #0a1d2f 50%, #07111a 100%)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "360px",
          padding: "40px 32px",
          borderRadius: "24px",
          border: "1px solid rgba(255,255,255,0.1)",
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(16px)",
          color: "#e2e8f0",
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{ fontSize: "36px", marginBottom: "8px" }}>🎨</div>
          <h1
            style={{
              margin: 0,
              fontSize: "24px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#fff",
            }}
          >
            Tablo
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: "13px",
              color: "rgba(255,255,255,0.45)",
            }}
          >
            Your self-hosted AI learning workspace
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <label
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.5)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: "8px",
            }}
          >
            Admin Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoFocus
            required
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.07)",
              color: "#fff",
              fontSize: "15px",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: "16px",
            }}
          />

          {error && (
            <div
              style={{
                color: "#f87171",
                fontSize: "13px",
                marginBottom: "12px",
                padding: "8px 12px",
                borderRadius: "8px",
                background: "rgba(248,113,113,0.1)",
                border: "1px solid rgba(248,113,113,0.2)",
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: "10px",
              border: "none",
              background: loading || !password
                ? "rgba(56,189,248,0.3)"
                : "rgba(56,189,248,0.85)",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 600,
              cursor: loading || !password ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p
          style={{
            marginTop: "24px",
            fontSize: "11px",
            color: "rgba(255,255,255,0.25)",
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Set <code style={{ color: "rgba(255,255,255,0.4)" }}>TABLO_ADMIN_PASSWORD</code> in{" "}
          <code style={{ color: "rgba(255,255,255,0.4)" }}>backend/.env</code>
        </p>
      </div>
    </main>
  );
}
