import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, Public_Sans } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Landing + /judge fonts only (applied via .landing-root; other pages untouched).
const displayFont = Archivo({
  subsets: ["latin"],
  weight: ["800", "900"],
  variable: "--font-display",
  display: "optional",
});
const bodyFont = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "optional",
});
const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-landing-mono",
  display: "optional",
});

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  metadataBase: new URL('https://daari-sentinel.vercel.app'),
  title: "Daari Sentinel: know what's ahead, and when it clears",
  description:
    'Road cameras spot incidents. Meta AI tells drivers behind what happened, when it clears, and whether to stay, reroute or wait.',
  openGraph: {
    title: "Daari Sentinel: know what's ahead, and when it clears",
    description:
      'Road cameras spot incidents. Meta AI tells drivers behind what happened, when it clears, and whether to stay, reroute or wait.',
    url: 'https://daari-sentinel.vercel.app',
    siteName: 'Daari Sentinel',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Daari Sentinel traffic alert: crash ahead with stay, reroute and wait options',
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: "Daari Sentinel: know what's ahead, and when it clears",
    description:
      'Road cameras spot incidents. Meta AI tells drivers behind what happened, when it clears, and whether to stay, reroute or wait.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${displayFont.variable} ${bodyFont.variable} ${monoFont.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
