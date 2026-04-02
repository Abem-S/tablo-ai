"use client";

import dynamic from "next/dynamic";

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

export default function Home() {
  return <TabloWorkspace />;
}
