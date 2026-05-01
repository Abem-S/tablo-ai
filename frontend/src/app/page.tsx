"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { LockScreen } from "@/components/lock-screen";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

const TabloWorkspace = dynamic(
  () =>
    import("@/components/tablo-workspace").then((mod) => mod.TabloWorkspace),
  {
    ssr: false,
    loading: () => (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.24),_transparent_32%),linear-gradient(180deg,_#113c66_0%,_#0a1d2f_52%,_#08131f_100%)] text-slate-50">
        <div className="mx-auto flex min-h-screen max-w-[1600px] items-center justify-center px-4 py-4 lg:px-6">
          <div className="rounded-[28px] border border-white/10 bg-white/8 px-6 py-5 text-sm text-slate-200 backdrop-blur">
            Loading Tablo workspace...
          </div>
        </div>
      </main>
    ),
  }
);

type AuthState = "checking" | "locked" | "unlocked";

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    async function checkAuth() {
      try {
        // Check if auth is enabled on this backend instance
        const res = await fetch(`${API_BASE_URL}/auth/status`);
        if (!res.ok) {
          // Backend unreachable — let the workspace handle the error
          setAuthState("unlocked");
          return;
        }
        const data = await res.json();

        if (!data.auth_enabled) {
          // No password set — open dev mode
          setAuthState("unlocked");
          return;
        }

        // Auth is enabled — check for existing session token
        const stored = sessionStorage.getItem("tablo_token");
        if (stored) {
          // Validate the stored token with a quick authenticated request
          const check = await fetch(`${API_BASE_URL}/documents`, {
            headers: { Authorization: `Bearer ${stored}` },
          });
          if (check.ok) {
            setToken(stored);
            setAuthState("unlocked");
            return;
          }
          // Token expired or invalid — clear it
          sessionStorage.removeItem("tablo_token");
        }

        setAuthState("locked");
      } catch {
        // Network error — let the workspace handle it
        setAuthState("unlocked");
      }
    }

    void checkAuth();
  }, []);

  if (authState === "checking") {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.24),_transparent_32%),linear-gradient(180deg,_#113c66_0%,_#0a1d2f_52%,_#08131f_100%)] text-slate-50">
        <div className="mx-auto flex min-h-screen max-w-[1600px] items-center justify-center">
          <div className="text-sm text-slate-400">Connecting…</div>
        </div>
      </main>
    );
  }

  if (authState === "locked") {
    return (
      <LockScreen
        onUnlocked={(t) => {
          setToken(t);
          setAuthState("unlocked");
        }}
      />
    );
  }

  return <TabloWorkspace authToken={token} />;
}
