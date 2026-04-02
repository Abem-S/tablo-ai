import type { Metadata } from "next";
import "./globals.css";
import "tldraw/tldraw.css";

export const metadata: Metadata = {
  title: "Tablo",
  description: "Board-first Socratic AI workspace for collaborative learning.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
