# SillyTavern CloudConfig (配置云同步插件)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-1.18.0+-orange.svg)](https://github.com/SillyTavern/SillyTavern)
[![Node](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

一个专为 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（酒馆）设计的高可靠、多设备配置云同步与防冲突管理插件。

---

## 📖 简介

在使用 SillyTavern 时，你是否经常在**电脑、平板、手机（Termux）**或多个浏览器之间切换？频繁导入导出预设和世界书不仅麻烦，而且多端修改时极易发生**“后修改的配置把前修改的静默覆盖”**，导致精心调试的提示词或配置意外丢失。

**SillyTavern CloudConfig** 为解决上述痛点而生：
- 依托 SillyTavern 官方多用户鉴权体系，实现同账号多设备自动安全同步；
- 采用数据库级原子 CAS 乐观锁并发保护，彻底杜绝静默覆盖；
- 本地冷备份机制，即使云端误删或关闭同步，也能一键安全还原。

---

## ✨ 核心特性

- 🔄 **精细化按需同步**：精确到单个对象粒度（某个预设、某本世界书），支持在 UI 界面中按需勾选开启，拒绝无脑全量打包覆盖。
- 🛡️ **强一致性并发保护（CAS）**：多设备同时修改同一配置时，系统自动拦截后到请求并报 `409 Conflict`，弹出清晰的三选一决策窗口（拉取云端 / 强制覆盖 / 稍后处理）。
- 🧊 **本地安全冷备份（Local Fallback）**：首次为某项配置开启同步时，客户端会在本地 IndexedDB 生成冷备份；关闭同步时可一键无损回滚至开启前的本地原始内容。
- 👥 **多账号严格隔离**：完全遵循 ST 官方多用户鉴权（`req.user`），元数据与 Blob 存储物理级账号隔离，切换账号互不可见。
- ⚡ **零原生编译门槛**：采用现代纯 Node 驱动方案（支持 Node 22+ 原生 SQLite），无需配置复杂的 Visual Studio C++ 工具链，对 **Android (Termux)** 和 Windows 用户极度友好。
- 📡 **轻量级增量感知**：低频增量游标轮询结合浏览器 `BroadcastChannel` 跨标签页广播，极低资源占用，不影响正常对话流畅度。

---

## 📦 支持的配置类别

| 配置类别 | 说明 | 当前状态 |
| :--- | :--- | :---: |
| **settings** | SillyTavern 主配置文件 (`settings.json`) | ✅ 已支持（UI 默认展示） |
| **openai_preset** | OpenAI 接口预设 | ✅ 已支持（UI 默认展示） |
| **world** | 世界书 / Lorebooks (`.json`) | ✅ 已支持（UI 默认展示） |
| **textgen / novel / kobold** | 本地模型与特定服务预设 | 📦 代码已支持（默认折叠隐藏） |
| **跨账号分享管理界面** | 分享码与权限审批 UI 交互 | 🚧 规划中 (Phase 2) |
| **character** | 角色卡卡片数据 | 🚧 规划中 (Phase 2) |
| **instruct / context** | Instruct 模板与上下文配置 | 🚧 规划中 (Phase 2) |
| **background / avatar** | 背景、头像等二进制资源 | ⏳ 规划中 (Phase 3) |

> **说明**：
> 1. **Phase 1（当前阶段）** 核心目标为**原子 CAS 同步引擎、安全物理隔离与多版本管理**；跨账号分享码的 UI 创建与审批流程将在 Phase 2 完整推出。
> 2. **软删除语义**：当云端配置项被标记为软删除（墓碑状态）后，常规拉取最新版会返回 `404 Not Found`（防止离线设备复活已删除配置）；如需找回，支持传入具体历史版本号拉取恢复。
> 3. **敏感数据严格隔离**：通用设置（`settings`）包含 API 密钥与认证凭证，插件在拉取、配置列表、所有者查询、变更事件四大通道上实施全面硬隔离，绝不发生跨账号越权与数据泄露。

---

## 🛠️ 安装与部署指南

### 前置条件
1. **SillyTavern**：版本 >= 1.18.0
2. **Node.js**：版本 >= 18（推荐 Node.js 20 或 22+）

### 第一步：开启 SillyTavern 多用户与插件开关
编辑 SillyTavern 根目录下的 `config.yaml`（若不存在可从 `default/config.yaml` 复制）：
```yaml
# 开启多用户模式
enableUserAccounts: true

# 开启服务端插件支持（必须为 true）
enableServerPlugins: true
```

### 第二步：安装插件
进入 SillyTavern 的插件目录 `plugins/`，克隆本仓库：

```bash
cd SillyTavern/plugins
git clone https://github.com/zgy-beep/SillyTavern-CloudConfig.git cfgsync
cd cfgsync
npm install
```

> **提示**：目录名建议设为 `cfgsync`，插件将自动挂载至 `/api/plugins/cfgsync/*`。

### 第三步：启动 SillyTavern
启动或重启你的 SillyTavern 服务端：
```bash
node server.js
```
终端输出包含以下内容即代表插件加载成功：
```text
[SillyTavern-CloudConfig] Initializing v0.1.0...
[SillyTavern-CloudConfig] Initialization complete.
```

---

## 🖥️ 使用指南

1. **登录账号**：在浏览器中打开 SillyTavern 并登录你的账号。
2. **打开插件面板**：
   - 打开 SillyTavern 右侧侧边栏设置抽屉（Extensions / 扩展设置）；
   - 展开 **【☁️ 配置云同步 (CloudConfig)】** 面板。
3. **勾选同步**：
   - 面板会自动列出你本地已有的设置、各类预设与世界书；
   - 勾选开关即可为该配置项开启云同步。
4. **手动操作**：
   - **推云端**：将本地当前编辑推送到云端版本库；
   - **拉云端**：从云端拉取最新版本覆盖本地。
5. **冲突处理**：
   - 当其他设备已经提交了更新而你本地也尝试提交时，会触发冲突提示弹窗，可自主选择拉取最新版或覆盖。
6. **安全关闭与回退**：
   - 当你取消勾选关闭某项同步时，系统会弹出提示：“是否恢复为开启同步前的本地原始配置？”；
   - 点击确认即可立即恢复为未同步前的初始状态。

---

## ❓ 常见问题 (FAQ)

<details>
<summary><strong>Q: 插件开启后会弄乱我原有的酒馆配置吗？</strong></summary>
不会。插件采取“严格白名单勾选”策略，未勾选的配置完全保持本地原样。首次开启勾选时会在本地浏览器 IndexedDB 中生成冷备份，关闭时可一键原样还原。
</details>

<details>
<summary><strong>Q: Android (Termux) 手机端可以使用吗？</strong></summary>
完全支持。由于本插件优先利用 Node.js 原生内置存储与纯 JS 协议实现，避开了必须编译 C++ 原生动态链接库（`node-gyp`）的依赖，Termux 环境无需安装繁琐的 build-essential 即可直接运行。
</details>

<details>
<summary><strong>Q: 两个设备同时改了同一个世界书怎么办？</strong></summary>
插件的后端核心基于原子 CAS（Compare-And-Swap）版本控制，后提交的设备不会静默覆盖前者的内容，而是会收到冲突警告并弹窗提醒用户选择处理方式。
</details>

---

## 📄 开源许可证

本项目采用 [MIT License](./LICENSE) 协议开源。
