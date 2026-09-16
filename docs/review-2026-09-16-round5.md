# SillyTavern-CloudConfig 插件 · 审核测试报告 (第 5 轮 · NEW-04 闭环 / 收尾)

| 项 | 内容 |
|---|---|
| 报告日期 | 2026-09-16 |
| 审核人 | 糯宝 (Nuobao) |
| 轮次 | 第 5 轮 (NEW-04 闭环验证 + 防误伤 / 防绕过对抗测试) |
| 被测版本 | **commit 2de54c4** (ix: resolve NEW-04 hard-rejected settings leakage in list endpoints …, 2026-09-16 10:23:45) |
| 环境 | SillyTavern 1.18.0 (Docker / Node v24.18.0), nableUserAccounts: true、nableServerPlugins: true |
| **总体结论** | **NEW-04 已闭环，无遗留缺陷**；自带测试 **27/27 全部通过** ✅；端到端 **48/48 全绿** ✅；**判定 Phase 1 达到可发布标准** 🚀 |

---

## 一、NEW-04 闭环验证 ✅

### 修复方式（方案 A）
1. src/common/constants.js：新增 NON_SHAREABLE_CONTENT_TYPES = ['settings'] 与统一判定函数 isShareableContentType()；
2. AuthorizationService：can() 与 hasApprovedGrant() 增加硬拒分支；stmtCheckGrant 增加 AND content_type <> 'settings'（即使库中存在异常记录也绝不匹配）；
3. outer.js：/owners（带参和无参）与 items?all_owners=true 追加对 settings 跨账号授权的过滤；
4. ChangeEventBus：变更事件过滤同样排除 settings 的跨账号广播。

### 实测（第 4 轮失败的 3 条断言全部转绿）

| # | 断言 | 第 4 轮 | 本轮实测 |
|---|---|---|---|
| 33 | settings 公开授权：/pull 与 ll_owners 判定一致 | ❌ 列表可见 | ✅ pull 403、列表**不可见** |
| 42 | settings 公开授权：/owners?content_type=settings 不得列出 | ❌ 列出了 | ✅ **不列出** |
| 44 | 用真实 settings 对象复现的 ll_owners 一致性 | ❌ 可见 | ✅ **不可见** |

---

## 二、防误伤 / 防绕过验证（全部通过）

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 45 | **本人**推/拉自己的 settings | 必须正常（硬拒只针对跨账号） | ✅ 推 200、拉 200 (version=2) |
| 46 | 存在 settings 授权时，B 的 /changes | 不出现 A 的 settings 事件 | ✅ B 共见 14 条事件，A 的 settings 事件 **0 条** |
| 47 | **本人**的 /changes | 仍能看到自己的 settings 事件 | ✅ A 共见 20 条，其中自己的 settings 事件 **4 条** |
| 48 | 变换大小写 (content_type=Settings) | 不得套出 settings 数据 | ✅ items → **400** (类别不支持)；/owners → **200 但 owners 为空**，无泄露 |
| 39-41 | 合法可共享类别 (openai_preset) 的授权 | 仍正常可见 | ✅ 带参加载正常、不带参向后兼容 |
| 43 | 已撤销授权 | 不出现在 /owners | ✅ 撤销后不再可见 |

> **核心判定**：硬拒规则在 **拉取 / 列表 / 所有者 / 事件** 四个通道上**同时生效**，且**只隔离跨账号**，本人流程与合法预设共享均无任何影响。

---

## 三、五轮审核总览（问题完全收敛）

| 轮次 | 被测版本 | 自带测试 | 端到端 | 本轮发现与状态 |
|---|---|---|---|---|
| 第 1 轮 | de50fba | 24/24 | 19/23 | BUG-01 跨账号读取未隔离、BUG-02 越权泄露、BUG-03 候选目录越界、BUG-04 前端 409 覆盖 |
| 第 2 轮 | 5453552 | 24/24 | 31/32 | BUG-01~04 确认修复；发现 NEW-01(NULL 授权语义)、NEW-02(入口说明)、BUG-05 |
| 第 3 轮 | 39cd7ec | 25/25 | 38/38 | NEW-01/02、BUG-05、单测全部闭环；提出建议 NEW-03(/owners 支持按类别过滤) |
| 第 4 轮 | c615f7c | 26/26 | 41/44 | NEW-03 闭环；发现 NEW-04(settings 硬拒需在列表与事件总线侧一致收敛) |
| **第 5 轮** | **2de54c4** | **27/27** | **48/48** | **NEW-04 彻底闭环，无新增缺陷，48 项端到端全绿** ✅ |

---

## 四、发布结论

- **判定**：**Phase 1（原子 CAS 同步引擎 + 多账号物理隔离 + 多版本管理）达到正式可发布标准**。
- **发布基线**：冻结提交 **2de54c4** 作为 Phase 1 正式发布基线。
