import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal Canvas | Wi‑Fi RSSI 히트맵",
  description:
    "아파트 도면에 RSSI 측정점을 기록하고 IDW 또는 Gaussian 히트맵을 만드는 브라우저 기반 도구",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
