# Sonic Board

Sonic Board 是一个面向盯鞋与氛围吉他的开源浏览器效果器工作台。它提供可拖拽的经典单块界面、串联/双路并联、立体声宽度、固定真实 DI 吉他采样、箱头箱体选择、离线 WAV 导出，以及能读取并调整当前板面的站内音色 Agent。

在线版本：[h5.tryx402.xyz](https://h5.tryx402.xyz/)

## 建模状态

项目不会把“目标分”冒充成已验证还原度。

| 参考对象 | 当前运行引擎 | 自动门禁 | 真机盲测 | 当前结论 |
| --- | --- | --- | --- | --- |
| Big Muff Pi Ram's Head、Op-Amp Big Muff、RAT 2、DS-1、BD-2、Klon Centaur | SPICE 网表 + DK 实时电路求解 / WASM | 与 ngspice 同网表对齐（最差 NRMSE 0.05–1.1%）、逐旋钮响应、零 Newton 失败 | 未完成 | 原理图级候选，目标 ≥8，未评分 |
| Dyna Comp、CE-2、OCD | PedalKernel WDF / WASM | 持续输出、有限值、输出校准、逐旋钮响应通过 | 未完成 | 电路候选，目标 ≥8，未评分 |
| Fuzz Face | PedalKernel WASM 实时修正路径 | 持续输出、有限值、输出校准、逐旋钮响应通过 | 未完成 | 实时修正候选，目标 ≥8，未评分 |
| DM-2、Deluxe Memory Man | Web Audio BBD 近似 | 持续输出、有限值、输出校准、逐旋钮响应通过 | 未完成 | 回退近似，未评分 |
| SD-1、TS808、Phase 90 | PedalKernel WDF / WASM | 持续输出、有限值、输出校准、逐旋钮响应通过 | 未完成 | 电路候选，目标 ≥8，未评分 |

电路求解引擎位于 `dsp/circuit`：每个单块是一份可以直接交给 ngspice 的 SPICE 网表，浏览器里用节点 DK 方法逐采样求解（牛顿迭代 + SPICE 结限幅，困难采样回退到 Levenberg-Marquardt、同伦延拓与时间子步）。各网表的原理图来源、交叉核对和不确定元件写在文件头，验证数据见 [`dsp/circuit/models/README.md`](dsp/circuit/models/README.md)。NRMSE 衡量的是求解器对原理图的忠实度，不是与真机的接近程度；`dsp/circuit/examples/capture.rs` 提供与 reamp 真机录音对比的工具。

其余效果器、箱头与箱体目前仍是非官方算法近似。经典名称只用于说明参考对象，不表示厂商授权或官方模型。

PedalKernel 固定在提交 `0278b397c861b5ebef2e8e38d15ab281b8e669dc`。浏览器运行层位于 `dsp/pedalkernel-wasm`，其中包含对上游示例断音、无效旋钮与电平差异的可审计修正；预编译产物为 `public/audio/pedalkernel.wasm`，实时处理器为 `public/audio/pedalkernel-processor.js`。其中 Big Muff Pi 与 Fuzz Face 使用同一 WASM 运行层中的轻量实时修正路径，并非完整逐采样 WDF 求解；两者以及其余候选都尚未完成真机盲测，`verifiedScore` 仍为 `null`。

## 本地运行

需要 Node.js 22.13+。

```bash
npm ci
npm test
npm run dev
```

生产构建：

```bash
npm run lint
npm run typecheck
npm run build
```

重新编译 WASM 需要 Rust 与 `wasm32-unknown-unknown` 目标：

```bash
npm run build:dsp        # PedalKernel
npm run test:dsp
npm run build:circuit    # 电路求解引擎
npm run test:circuit
```

电路网表的 ngspice 对照验证需要本机安装 ngspice：`dsp/circuit/scripts/validate.sh`。

常规 Web 构建直接使用仓库中已提交的 WASM，不要求托管环境安装 Rust。

## 目录

- `app/audio`：Web Audio 图、采样渲染、路由与回归测试
- `app/effects`：效果器目录、参数帮助与保真状态
- `app/agent`：Pi Agent、站内工具与可逆操作
- `dsp/circuit`：SPICE 网表电路求解引擎、单块网表、ngspice 验证与真机对比工具
- `dsp/pedalkernel-wasm`：PedalKernel 浏览器封装与固定电路定义
- `public/audio`：真实 DI 素材、AudioWorklet 和编译后的 WASM（`circuit.wasm` / `pedalkernel.wasm`）

## 许可证

Sonic Board 原创代码以 [GNU AGPL v3 或更高版本](LICENSE)发布。PedalKernel、复制的 `.pedal` 电路定义及其编译产物适用上游许可证，其中包含 AGPLv3 Section 7 的额外硬件商业条件；详见 [NOTICE.md](NOTICE.md) 与 [PedalKernel-LICENSE.txt](THIRD_PARTY_LICENSES/PedalKernel-LICENSE.txt)。

真实吉他 DI 素材来自 FreePats 的 CC0 Direct DI 采样，详情见 `NOTICE.md`。
