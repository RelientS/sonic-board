import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sonic Board — 盯鞋音色工作台',
  description: '用 19 块经典结构效果器搭建盯鞋音色链，实时试听、A/B、保存音色并导出 WAV。',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
