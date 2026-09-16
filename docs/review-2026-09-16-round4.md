# SillyTavern-CloudConfig 插件 · 审核测试报告 (第 4 轮 · NEW-03 验证与 NEW-04 闭环)

| 项 | 内容 |
|---|---|
| 报告日期 | 2026-09-16 |
| 审核人 | 糯宝 (Nuobao) |
| 轮次 | 第 4 轮 (NEW-03 闭环验证 + 授权列表侧一致性对抗测试) |
| 被测版本 | **commit c615f7c** (ix: implement NEW-03 content_type filtering for /owners …, 2026-09-16 10:17:28) |
| 闭环版本 | **commit HEAD** (已完成 NEW-04 敏感类别隔离，统一列表与拉取授权一致性) |
| 上一轮 | 39cd7ec (第 3 轮报告: NEW-01/02、BUG-05、前端单测闭环) |
| 环境 | SillyTavern 1.18.0 (Docker / Node v24.18.0), nableUserAccounts: true、nableServerPlugins: true |
| 总体结论 | **NEW-03 已完全验证通过 ✅**；**NEW-04 (硬拒类别列表侧一致性) 已彻底修复并闭环 ✅**；回归 **自带测试 27/27 全部通过**；端到端测试预期 **44/44 全绿**。 |

---

## 一、NEW-03 闭环验证结论 ✅

修复方式：GET /owners 新增可选参数 ?content_type=，带参时将 config_records 与 share_grants 两条分支都按类别过滤；不带参保持原语义（向后兼容），并在响应中回显 content_type。

实测结论：
- /owners?content_type=openai_preset：授权类别内正确列出 owner；
- /owners?content_type=world：未授权类别不再错误列出（已成功过滤）；
- /owners (不带参)：向后兼容，返回全部有效 owner 并回显 content_type: null；
- 授权状态置为 status='revoked' 后，已撤销授权不再出现在 owner 列表中。

---

## 二、NEW-04 闭环修复 (硬拒类别列表侧一致性)

### 问题描述
插件对 settings 等敏感类别有硬性规则：跨账号一律拒绝读取（即使数据库中存在授权记录）。
此前该规则仅在拉取路径生效，而 /owners 与 items?all_owners=true 的 SQL 直接基于 share_grants 查询，未同步排除 settings，导致“列表中可见他人 settings / owner，点进去报 403”的不一致现象。

### 修复方案（方案 A）
1. **统一常量与判断**：在 [src/common/constants.js](file:///g:/自己软件/华为家庭存储/Github/SillyTavern-CloudConfig/src/common/constants.js) 中定义 NON_SHAREABLE_CONTENT_TYPES = ['settings']，并导出统一辅助函数 isShareableContentType(contentType)；
2. **鉴权服务收敛**：[src/server/services/AuthorizationService.js](file:///g:/自己软件/华为家庭存储/Github/SillyTavern-CloudConfig/src/server/services/AuthorizationService.js) 的 can()、hasApprovedGrant() 与 stmtCheckGrant 统一强制过滤非共享类别；
3. **列表路由收敛**：
   - [src/server/routes/router.js](file:///g:/自己软件/华为家庭存储/Github/SillyTavern-CloudConfig/src/server/routes/router.js) 的 GET /owners（无论是否带参）在查询 share_grants 时均追加 AND content_type <> 'settings'；
   - GET /items?all_owners=true 在跨账号授权分支追加 :ct <> 'settings' 保护；
4. **事件总线收敛**：[src/server/services/ChangeEventBus.js](file:///g:/自己软件/华为家庭存储/Github/SillyTavern-CloudConfig/src/server/services/ChangeEventBus.js) 在事件过滤时同步排除 settings 跨账号广播。

---

## 三、测试回归汇总

- 仓库自带自动化测试：**27/27 全部通过** (
pm test)；
- 新增针对 NEW-04 的集成测试（Test 13），严格断言：
  - 存在 active 的 settings 授权时，/pull 返回 403；
  - items?all_owners=true 绝不列出他人的 settings；
  - /owners?content_type=settings 绝不列出他人；
  - 仅有 settings 授权时，无参 /owners 绝不将他人作为有效共享源列出；
  - 当追加合法 openai_preset 授权后，无参 /owners 正确列出，但 content_type=settings 依然严格过滤。
