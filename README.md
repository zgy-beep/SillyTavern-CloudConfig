# SillyTavern CloudConfig (配置云同步与共享插件)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![SillyTavern](https://img.shields.io/badge/SillyTavern-1.18.0+-orange.svg)

一个为 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 设计的多设备配置云同步与跨账号安全共享插件。

---

## 🌟 核心特性

1. **多设备配置同步**：按用户勾选的配置类别（Settings、各类 Presets、World Info、Character 等）精准粒度同步，新设备一键拉取。
2. **多账号安全隔离**：基于 SillyTavern 官方多用户中间件鉴权（`req.user`），元数据与存储严格按账号隔离。
3. **同账号免授权 / 跨账号授权读取**：
   - 同账号多设备自动同步已绑定配置。
   - 跨账号支持**分享码模式**与**审批模式**，支持单个对象或整类配置授权（只读），安全防篡改。
4. **强一致性与并发保护**：
   - 基于版本号的原子 CAS（Compare-And-Swap）机制，彻底杜绝后写静默覆盖前写。
   - 冲突时提示差异并允许用户主动决策。
5. **本地安全回退（Local Fallback）**：
   - 开启同步前在浏览器端（IndexedDB）保留冷备份。
   - 关闭同步或云端删除时，可无损回滚至开启前本地原始内容。
6. **轻量变更感知**：
   - 服务端基于全局事件序列与权限过滤，客户端轮询（低开销）主动感知更新，不打扰正在进行的交互。

---

## 📁 文档与规范

- 完整架构设计与数据模型规范：参考内部计划书 `SillyTavern配置云同步插件-计划书.md`

---

## 🗺️ 开发路线图

- [ ] **Phase 1 (P0)**：核心同步引擎
  - 核心配置适配器（`settings`、各类 `preset`、`world`）
  - SQLite 元数据与版本表（`config_records`、`config_versions`、`change_events`）
  - 原子 CAS 写入流程（创建/更新/删除/回滚）
  - 前端扩展基础界面、IndexedDB 绑定与本地冷回退机制
- [ ] **Phase 2 (P1)**：跨账号授权与扩展类型
  - 分享码机制（哈希存储、单次/多次认领）与审批流
  - 审计日志系统（`audit_logs`）
  - `character`（卡片主体数据）、`instruct`、`context`、`sysprompt` 等类型支持
- [ ] **Phase 3 (P2)**：二进制资产与体验打磨
  - 二进制适配器（`background`、`avatar`、`sprites`、`theme` 等）
  - WebSocket 升级评估与实时推送通道
  - 自动化测试套件与安全审查

---

## 📄 许可证

本项目采用 [MIT License](./LICENSE) 开源协议。
