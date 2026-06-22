import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI智聊 - 智能实时对话系统",
  description: "基于多模态架构的AI实时聊天系统，WebSocket 句子级流式 + 语音播报 + 立绘生成。",
  keywords: ["AI智聊", "WebSocket", "语音流式", "图像生成", "多模态", "实时聊天"],
  authors: [{ name: "AI ZhiChat Team" }],
  openGraph: {
    title: "AI智聊 - 智能实时对话系统",
    description: "语音流式 · 立绘生成 · 意图路由",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
