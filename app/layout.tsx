import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LINE Slip Admin",
  description: "Admin dashboard for LINE slip storage and cleanup"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
