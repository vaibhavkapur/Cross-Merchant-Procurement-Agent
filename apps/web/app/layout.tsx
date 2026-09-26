import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cross-Merchant Procurement",
  description: "Compare suppliers and purchase through UCP or ACP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-screen">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <header className="mb-8 flex items-end justify-between border-b border-slate-800 pb-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sky-400">Fixture demo</p>
              <h1 className="text-2xl font-semibold">Cross-Merchant Procurement Agent</h1>
            </div>
            <p className="text-sm text-slate-400">Alice Nguyen · Acme Robotics · USD</p>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
