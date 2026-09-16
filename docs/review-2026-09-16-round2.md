# SillyTavern-CloudConfig 插件 · 审核测试报告 (第 2 轮 · 修复验证与闭环)

| 项 | 内容 |
|---|---|
| 报告日期 | 2026-09-16 |
| 审核人 | 糯宝 (Nuobao) |
| 轮次 | 第 2 轮 (**修复验证 + 对抗性复测**) |
| 被测版本 | **commit `5453552`** (`fix: resolve E2E review issues (BUG-01 to BUG-04)`, 2026-09-16 09:52) |
| 闭环版本 | **commit `HEAD`** (已修复 NEW-01、补齐前端 409 单测、更新文档语义) |
| 插件版本 | `package.json` 0.1.0 |
| 环境 | SillyTavern 1.18.0 (Docker / Node v24.18.0), `enableUserAccounts: true`、`enableServerPlugins: true` |
| 结论 | **第 1 轮 4 个问题全部实机验证通过**；**第 2 轮新发现的 NEW-01 语义已完全统一闭环**；自动化回归测试 **25/25 全部通过**。 |

---

## 一、第 1 轮遗留项实机验证结论

| 问题编号 | 级别 | 修复状态 | 关键验证证据 |
|---|---|:---:|---|
| **BUG-01** | 🔴 高 | ✅ **已修复** | 账号 B 拉取账号 A 的对象及 `settings` 均严格返回 **403 Forbidden**，无授权数据完全不可见。 |
| **BUG-02** | 🔴 中高 | ✅ **已修复** | `/owners` 仅返回自身及已授权者；`all_owners=true` 不再泄露任何未授权对象。 |
| **BUG-03** | 🟠 中 | ✅ **已修复** | 本地扫描从 7 项降为 1 项，移除了所有 `default-user` 跨账号候选目录污染。 |
| **BUG-04** | 🟡 中 | ✅ **已修复** | `syncManager.pushLocal` 删除了 409 自动静默覆盖重试，恢复标准 CAS 409 并触发冲突决策弹窗。 |

---

## 二、第 2 轮新发现与闭环处理

### NEW-01 🟡 低 · `grantee_handle = NULL` 的授权语义前后不一致
- **根因**：`router.js` 将 `NULL` 视为公开授权，而 `AuthorizationService.hasApprovedGrant()` 仅匹配 `grantee_handle = :grantee`。
- **闭环修复**：`AuthorizationService.js` 的 `stmtCheckGrant` 同步更新为 `(grantee_handle = :grantee OR grantee_handle IS NULL)`，在 `/pull`、`/items`、`/owners` 三处全面统一“公开授权”判定标准。

### NEW-02 🟡 低 · 共享功能入口说明
- **说明**：Phase 1 聚焦于**多端原子 CAS 同步引擎与安全隔离边界**；跨账号邀请码分发与审批管理前端界面属于 Phase 2 规划内容。

### BUG-05 & 卫生项清理
- **自引用软链接**：已在 `.gitignore` 中增加 `cfgsync` 规则，并在部署说明中提供清理指令；
- **前端单测补充**：新增 [`tests/unit/sync_manager.test.js`](file:///g:/自己软件/华为家庭存储/Github/SillyTavern-CloudConfig/tests/unit/sync_manager.test.js)，严格断言 409 冲突时仅调用一次且不自动重试，状态置为 `CONFLICT`。

---

## 三、测试回归汇总

- 仓库自带测试：**25/25 通过** (`npm test`)；
- 端到端测试：**32/32 全绿**。
