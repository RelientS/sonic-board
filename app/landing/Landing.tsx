'use client';

import { useSyncExternalStore, type CSSProperties } from 'react';

import { EFFECT_SPECS } from '../effects/catalog.ts';
import { getEffectFidelity } from '../effects/fidelity.ts';
import { StringField } from './StringField.tsx';
import './landing.css';

const CIRCUIT_PEDALS = EFFECT_SPECS.filter((spec) => getEffectFidelity(spec.id)?.runtime === 'circuit');

const CHAIN = [
  { title: '吉他', body: '内置真实 DI 录音，也可以通过声卡插上你自己的琴实时弹。' },
  { title: '单块', body: '按原厂电路图逐个元件计算：晶体管、运放、二极管都是原值，旋钮就是电位器。' },
  { title: '音箱', body: '单体音箱，或者箱头配箱体自由组合。推得越狠，失真越自然地压缩。' },
  { title: '箱体', body: '实测脉冲响应：Mesa 2×12 V30 和 Marshall 4×12 Greenback，麦克风位置可调。' },
];

const noSubscribe = () => () => {};

/** Opens the studio, carrying `?ref=` so invitations still count. */
function useStudioHref() {
  const search = useSyncExternalStore(noSubscribe, () => window.location.search, () => '');
  return '/studio' + search;
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => false);
}

/** The model name as silk-screened on the enclosure (maker dropped). */
function silkName(spec: (typeof CIRCUIT_PEDALS)[number]) {
  const maker = spec.maker.toLowerCase();
  const name = spec.name.toLowerCase().startsWith(maker) ? spec.name.slice(spec.maker.length).trim() : spec.name;
  return name.replace(/^(Co|-)\s+/i, '');
}

function PedalTile({ spec }: { spec: (typeof CIRCUIT_PEDALS)[number] }) {
  const knobs = Math.min(4, spec.controls.filter((control) => !control.options).length);
  const style = { '--finish': spec.finish, '--ink': spec.ink, '--led': spec.accent } as CSSProperties;
  return (
    <li className={'pedal-tile' + (spec.wide ? ' is-wide' : '')} style={style}>
      <span className="pedal-tile-body" aria-hidden="true">
        <span className="pedal-tile-knobs">{Array.from({ length: knobs }, (_, index) => <i key={index} />)}</span>
        <b className="pedal-tile-led" />
        <span className="pedal-tile-silk">{silkName(spec)}</span>
        <span className="pedal-tile-switch" />
      </span>
      <span className="pedal-tile-name">{spec.name}</span>
    </li>
  );
}

export function Landing() {
  const studioHref = useStudioHref();
  const reduceMotion = usePrefersReducedMotion();

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="landing-brand">Sonic Board</span>
        <a className="landing-nav-cta" href={studioHref}>打开工作台</a>
      </header>

      <section className="landing-hero">
        <StringField reduceMotion={reduceMotion} />
        <h1>把整块效果器板，<br />搬进浏览器。</h1>
        <div className="landing-hero-foot">
          <div className="landing-hero-copy">
            <p>13 块经典单块按原厂电路图逐个元件仿真，接上真实音箱和实测箱体。在线调音色、A/B 对比、导出 WAV，也可以插上吉他直接弹。</p>
            <div className="landing-actions">
              <a className="landing-primary" href={studioHref}>打开工作台</a>
              <a className="landing-secondary" href="#chain">它是怎么发声的</a>
            </div>
          </div>
          {!reduceMotion && <p className="landing-hint">用鼠标划过琴弦</p>}
        </div>
      </section>

      <section className="landing-board" aria-labelledby="board-title">
        <div className="landing-section-head">
          <h2 id="board-title">板上的 {CIRCUIT_PEDALS.length} 块电路级单块</h2>
          <p>不是采样，也不是 EQ 加削波。每一块的模拟电路都和 SPICE 仿真逐个采样点对照过。</p>
        </div>
        <ul className="pedal-shelf">{CIRCUIT_PEDALS.map((spec) => <PedalTile key={spec.id} spec={spec} />)}</ul>
      </section>

      <section className="landing-chain" id="chain" aria-labelledby="chain-title">
        <div className="landing-section-head">
          <h2 id="chain-title">一个音从琴弦到耳朵</h2>
          <p>和真实的舞台一样，声音按这个顺序经过每一环。</p>
        </div>
        <ol className="chain-steps">
          {CHAIN.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-closing">
        <h2>去搭一块你自己的板。</h2>
        <a className="landing-primary" href={studioHref}>打开工作台</a>
      </section>

      <footer className="landing-footer">
        <span>Sonic Board，一个给盯鞋吉他手的在线效果器工作台。</span>
        <span>箱体脉冲响应来自 Dark Days（CC BY 4.0）和 Jester Dyne（CC0）。</span>
        <a href="https://github.com/RelientS/sonic-board" target="_blank" rel="noreferrer">源码</a>
      </footer>
    </div>
  );
}
