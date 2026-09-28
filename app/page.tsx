import type { Metadata } from 'next';

import { Landing } from './landing/Landing';

export const metadata: Metadata = {
  title: 'Sonic Board — 把整块效果器板搬进浏览器',
  description: '13 块经典单块按原厂电路图仿真，接真实音箱和实测箱体。在线调盯鞋音色、A/B 对比、导出 WAV。',
};

export default function Home() {
  return <Landing />;
}
