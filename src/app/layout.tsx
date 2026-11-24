import type { Metadata } from "next";
import { Geist, Geist_Mono, Pixelify_Sans } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { SessionControls } from "@/components/SessionControls";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const pixelify = Pixelify_Sans({ variable: "--font-pixelify", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Arena",
  description: "See what your AI agents are doing",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${pixelify.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <header className="border-b-2 border-line bg-panel">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
            <Link href="/" className="font-pixel text-xl tracking-wide text-text">
              <span className="text-working">▣</span> Arena
            </Link>
            <nav className="flex items-center gap-3 text-sm text-muted">
              <Link href="/" className="hover:text-text">
                Overview
              </Link>
              <Link href="/arenas/new" className="hover:text-text">
                New arena
              </Link>
            </nav>
            <div className="ml-auto">
              <Suspense fallback={null}>
                <SessionControls />
              </Suspense>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
