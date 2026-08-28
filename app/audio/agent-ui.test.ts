import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../agent/ToneAgentDock.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../layout.tsx', import.meta.url), 'utf8');

test('workbench exposes an accessible tone agent and clean input picker', () => {
  assert.match(page, /<ToneAgentDock/);
  assert.match(page, /captureToneAgentBoard/);
  assert.match(page, /function SourcePickerDialog/);
  assert.match(page, /className=\{'agent-open-button'/);
  assert.match(page, /aria-label=\{agentOpen \? '关闭音色 Agent' : '打开音色 Agent'\}/);
  assert.match(page, /aria-label="选择清音输入"/);
  assert.match(page, /真实采样 · 未处理 DI · CC0/);
  assert.match(page, /FreePats Direct DI/);
  assert.match(page, /performance\.description/);
  assert.doesNotMatch(page, /Black & Green Guitars/);
});

test('agent uses a persistent desktop dock and a mobile full-height workspace', () => {
  assert.match(styles, /\.tone-agent-dock[^}]*position:\s*fixed/s);
  assert.match(styles, /\.tone-agent-thread[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.source-picker-dialog/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.tone-agent-dock[^}]*inset:\s*0/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.tone-agent-composer textarea[^}]*font-size:\s*16px/s);
});

test('pedals, playback, and presets expose keyboard and loading state', () => {
  assert.match(page, /aria-label=\{String\(index \+ 1\)[\s\S]*?aria-current=\{selected \? 'true' : undefined\}/);
  assert.match(page, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(page, /if \(playbackLoading \|\| playbackLoadingRef\.current\) return/);
  assert.match(page, /disabled=\{playbackLoading\}/);
  assert.match(page, /正在加载试听，请稍候；重复点击不会中断加载/);
  assert.match(page, /aria-busy=\{playbackLoading\}/);
  assert.match(page, /role="progressbar"/);
  assert.match(page, /aria-valuenow=\{Math\.round\(progress\)\}/);
  assert.match(page, /aria-label=\{'载入 ' \+ preset\.name\}/);
  assert.match(page, /aria-current=\{isCurrent \? 'true' : undefined\}/);
  assert.doesNotMatch(page, /className="waveform" aria-label=\{'试听进度/);
});

test('agent modal traps focus, restores its opener, and makes background inert', () => {
  assert.match(agent, /role="dialog"/);
  assert.match(agent, /aria-modal="true"/);
  assert.match(agent, /closeButton\.current\?\.focus\(\)/);
  assert.match(agent, /returnFocus.*document\.activeElement/);
  assert.match(agent, /withInert\.inert = true/);
  assert.match(agent, /if \(event\.key !== 'Escape'\) return/);
  assert.match(agent, /function trapTab/);
  assert.match(agent, /event\.shiftKey \? last : first/);
});

test('mobile board hands vertical gestures to the page and clears transport overlay', () => {
  assert.match(styles, /--mobile-transport-clearance:\s*224px/);
  assert.match(styles, /touch-action:\s*pan-x/);
  assert.match(styles, /overscroll-behavior-y:\s*auto/);
  assert.match(styles, /overflow-y:\s*clip/);
  assert.match(styles, /\.board-stage \{ display: block;/);
  assert.match(styles, /scroll-margin-top:\s*-64px/);
  assert.match(styles, /padding: 14px 14px calc\(var\(--mobile-transport-clearance\)/);
  assert.match(styles, /\.board-pan-hint/);
});

test('layout points browsers at the existing favicon asset', () => {
  assert.match(layout, /icons:\s*\{[\s\S]*icon:\s*'\/favicon\.svg'/);
});

test('playback progress follows the active session clock and refresh failures recover safely', () => {
  assert.match(page, /function getPlaybackProgress\(session: LiveAudioSession \| null\)/);
  assert.match(page, /session\.context\.state === 'closed'/);
  assert.match(page, /session\.context\.currentTime/);
  assert.match(page, /session\.startedAt/);
  assert.match(page, /session\.duration/);
  assert.match(page, /const offset = \(\(elapsed % session\.duration\) \+ session\.duration\) % session\.duration/);
  assert.match(page, /const updateProgress = \(\) => \{/);
  assert.match(page, /const nextProgress = getPlaybackProgress\(session\)/);
  assert.match(page, /if \(session\?\.context\.state === 'closed'\)/);
  assert.match(page, /void playback\.stop\(\)\.catch\(\(\) => \{/);
  assert.doesNotMatch(page, /value \+ 1\.35/);
  assert.match(page, /refreshLiveSession\(session, audioConfig\)\.catch\(async \(\) => \{/);
  assert.match(page, /await playback\.stop\(\)/);
  assert.match(page, /setPlaying\(false\);\n\s*setProgress\(0\);\n\s*setAudioError\('试听更新失败，请重试。'\)/);
  assert.match(page, /当前浏览器无法启动试听，请检查声音权限/);
  assert.match(page, /setAudioError\('试听已停止，请重试。'\)/);
  assert.match(page, /playbackRefreshSerial/);
  assert.match(page, /refreshSerial !== playbackRefreshSerial\.current/);
});
