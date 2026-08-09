import type { Metadata } from "next";
import { Noto_Serif } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const displaySerif = Noto_Serif({
  display: "swap",
  subsets: ["latin", "vietnamese"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "FoodGuard — Chọn món, giữ bằng chứng",
  description:
    "Marketplace món Việt minh họa ký quỹ và bằng chứng công khai trên GenLayer StudioNet.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <body className={displaySerif.variable}>{children}</body>
    </html>
  );
}
