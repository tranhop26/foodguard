import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "FoodGuard — Chọn món, giữ bằng chứng",
  description:
    "Marketplace món Việt minh họa ký quỹ và bằng chứng công khai trên GenLayer StudioNet.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
