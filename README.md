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

## 账号与音色 Agent 额度

音色 Agent 需要登录后使用，额度按账号计算：

- 注册：用户名 3–24 位字母、数字、`_` 或 `-`，密码至少 8 位；密码以 scrypt 加盐存储，会话 Cookie `sb_session` 有效期 30 天（服务端只保存令牌的 SHA-256）。
- 额度：新账号 20 次，每次 Agent 请求在受理时扣 1 次；上游在产生任何输出前失败会自动退回。
- 分享得次数：每个账号都有邀请链接 `https://h5.tryx402.xyz/?ref=<邀请码>`。每成功邀请 1 人注册 +15 次，新用户 +5 次，最多 10 人；同一网络地址注册不计邀请奖励，每个 IP 24 小时内最多注册 3 个账号。
- 限流：每个账号每分钟最多 5 次 Agent 请求，全站同时最多 4 个进行中的请求；登录 / 注册每个 IP 每分钟最多 10 次。
- 额度流水是只追加的账本（`signup` / `referral` / `agent_use` / `refund` / `admin_grant`），后续接入付费充值只需新增条目类型。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `SONIC_DATA_DIR` | 账号 JSON 存储目录，默认 `./.data`（已加入 `.gitignore`）。生产环境应放在发布目录之外。 |
| `AGENT_UPSTREAM_URL` | 设置后 `/api/tone-agent` 作为网关，校验登录与额度后把 SSE 流原样转发到该地址；未设置时使用本机 Agent（需要 `TOKEN_SHARE_KEY`）。 |
| `AGENT_UPSTREAM_TIMEOUT_MS` | 上游请求超时，默认 240000。 |
| `AGENT_GATEWAY_SECRET` | 网关与上游共享的密钥：网关转发时附带 `X-Sonic-Gateway-Secret`，上游收到匹配的密钥时跳过账号校验直接运行 Agent。 |
| `SONIC_SITE_ORIGIN` | 额外允许的站点来源（同源校验），默认已包含 `https://h5.tryx402.xyz`。 |

管理脚本直接读写同一个 JSON 存储（与服务共用文件锁，可在服务运行时使用）：

```bash
SONIC_DATA_DIR=/srv/sonic-board/data node scripts/account-admin.mjs list
SONIC_DATA_DIR=/srv/sonic-board/data node scripts/account-admin.mjs show <用户名>
SONIC_DATA_DIR=/srv/sonic-board/data node scripts/account-admin.mjs grant <用户名> <次数> [备注]
```

## 目录

- `app/audio`：Web Audio 图、采样渲染、路由与回归测试
- `app/effects`：效果器目录、参数帮助与保真状态
- `app/agent`：Pi Agent、站内工具与可逆操作
- `app/account`：账号、会话、额度账本、邀请奖励与 Agent 网关逻辑
- `dsp/circuit`：SPICE 网表电路求解引擎、单块网表、ngspice 验证与真机对比工具
- `dsp/pedalkernel-wasm`：PedalKernel 浏览器封装与固定电路定义
- `public/audio`：真实 DI 素材、AudioWorklet 和编译后的 WASM（`circuit.wasm` / `pedalkernel.wasm`）

## 许可证

Sonic Board 原创代码以 [GNU AGPL v3 或更高版本](LICENSE)发布。PedalKernel、复制的 `.pedal` 电路定义及其编译产物适用上游许可证，其中包含 AGPLv3 Section 7 的额外硬件商业条件；详见 [NOTICE.md](NOTICE.md) 与 [PedalKernel-LICENSE.txt](THIRD_PARTY_LICENSES/PedalKernel-LICENSE.txt)。

真实吉他 DI 素材来自 FreePats 的 CC0 Direct DI 采样，详情见 `NOTICE.md`。
