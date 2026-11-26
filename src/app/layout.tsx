import type { Metadata, Viewport } from "next";
import EnvBadge from "@/components/EnvBadge";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DOC Bern Quiz", template: "%s · DOC Bern Quiz" },
  description: "Das Live Quiz vom Ducati Official Club Bern.",
  icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },
  // Das Quiz ist nicht für Suchmaschinen gedacht.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Der Inhalt reicht bis zu den Rändern, die Abstände regeln wir mit safe area Werten.
  viewportFit: "cover",
  themeColor: "#f5f5f7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de-CH">
      <body>
        <EnvBadge />
        {children}
      </body>
    </html>
  );
}
