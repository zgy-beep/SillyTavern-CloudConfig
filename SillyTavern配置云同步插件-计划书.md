# SillyTavern 配置云同步插件 — 项目计划书（定稿版）

版本：v0.5
目标环境：SillyTavern 1.18.0
目标规模：小团队/社群，十几到几十个账号，每账号数台设备/浏览器

本文档经过三轮架构审核迭代（v0.2 → v0.4.1 修复），核心数据模型与并发/安全边界已闭环，可作为第一期编码的直接依据。

---

## 一、需求概述

1. **多设备配置同步**：按用户勾选的配置类别（对齐 SillyTavern 官方 content type：settings / 各类 preset / world / character 等）分别同步，粒度精确到具体对象（某个预设、某本世界书），新设备登录后可选择性拉取。
2. **多账号支持**：依托 ST 已开启的多用户模式，身份判断唯一来源是 ST 登录中间件注入的 `req.user`。
3. **同账号免授权读取**：同一账号多设备自动读取自己勾选同步的配置。
4. **跨账号授权读取**：支持分享码模式和审批模式，授权范围可以是单个对象或整个类别（含未来新增），只读，未授权不可读，撤销后立即生效于未来的读取（但不追溯清除对方已下载的本地内容）。
5. **本地回退**：设备关闭某项同步后，恢复为该设备开启同步前的本地原始内容，备份/恢复完全由客户端负责。
6. **变更感知**：云端配置更新后，其它在线设备可通过轮询（预留 WebSocket 升级空间）感知"有新版本"，不自动静默覆盖。
7. **写入正确性**：多设备并发修改同一配置时必须能检测冲突，不允许后写静默覆盖前写；同一账号多浏览器不允许本地数据互相串线；对象被删除后不允许离线设备重新上线时使其"复活"。

---

## 二、技术前提（已核实，作为硬约束）

- `plugins/<name>/index.js` 导出 `init(router)`、`exit()`、`info`；`init` 只拿到一个 Express Router，最终挂载到 `/api/plugins/cfgsync/*`，**没有底层 `http.Server` 引用**，无法直接挂 WebSocket。第一版统一用轮询实现变更感知，WS 作为后续可插拔 transport。
- `config.yaml` 必须同时开启：
  ```yaml
  enableUserAccounts: true
  enableServerPlugins: true
  ```
  `enableServerPlugins` 默认关闭，必须显式开启插件才会被加载。
- `req.user` 的类型是：
  ```typescript
  { profile: User; directories: UserDirectoryList }
  ```
  **不是字符串**。账号 handle 取自 `req.user.profile.handle`；用户数据目录取自 `req.user.directories`，插件不自己拼接 `%DATA_ROOT%/%USER_HANDLE%`。
- Server Plugin **不是沙箱化的**，能访问整个文件系统，只应从可信来源安装，且自身代码要经过基本审查；对 ST 内部模块的依赖应尽量隔离在适配层内，不在插件各处随意 `import` ST 源码模块，降低 ST 版本升级带来的破坏性影响。
- ST 官方 recognized content type 清单本身混合了 JSON 配置（settings/各类 preset/world/instruct/context/quick_replies/sysprompt/reasoning）与二进制资源（character 可能含图片、background、avatar、sprites、theme、workflow），本插件的类型系统直接对齐这份清单，但存储层必须区分对待，不能统一按 JSON 处理。

---

## 三、系统架构

```
┌───────────────────────┐        ┌───────────────────────┐
│   设备/浏览器 A（在线）    │        │   设备/浏览器 B（在线）    │
│  ST 前端 + 本插件扩展UI    │        │  ST 前端 + 本插件扩展UI    │
│  ┌───────────────────┐ │        │  ┌───────────────────┐ │
│  │ IndexedDB（按账号隔离）│ │        │  │ IndexedDB（按账号隔离）│ │
│  │ client_instance_id  │ │        │  │ client_instance_id  │ │
│  │ sync_bindings        │ │        │  │ sync_bindings        │ │
│  │ local_backup          │ │        │  │ local_backup          │ │
│  │ last_acked_seq         │ │        │  │ last_acked_seq         │ │
│  └───────────────────┘ │        │  └───────────────────┘ │
└──────────┬──────────────┘        └──────────┬──────────────┘
           │ REST（push/pull/changes/...）                 │
           ▼                                                ▼
┌──────────────────────────────────────────────────────────────┐
│                     SillyTavern 服务器                          │
│  ┌───────────────────────────┐                                │
│  │  ST 多用户鉴权中间件           │ → AuthContext.fromRequest(req) │
│  └───────────────┬───────────────┘                                │
│                  ▼                                                │
│  ┌─────────────────────────────────────────────────────┐        │
│  │                 本插件 Server Plugin                     │        │
│  │  ConfigAdapter     （序列化/反序列化/canonicalize/delete） │        │
│  │  SyncService       （原子CAS：创建+更新+删除+rollback统一） │        │
│  │  SnapshotStore     （按类型存blob，有限历史版本）            │        │
│  │  AuthorizationService（READ/WRITE/ROLLBACK/SHARE/APPROVE） │        │
│  │  ChangeEventBus    （轮询，按可见范围过滤，去重取最新版本）    │        │
│  │  AuditService      （操作日志）                            │        │
│  └───────────────┬─────────────────────────────────────┘        │
│                  ▼                                                │
│  ┌─────────────────────────────────┐                            │
│  │ SQLite（服务器级共享一份，非每用户一份） │                            │
│  │   config_records / config_versions │                            │
│  │   change_events / share_grants     │                            │
│  │   share_requests / audit_logs      │                            │
│  ├─────────────────────────────────┤                            │
│  │ Blob 存储（放在各用户目录下）          │                            │
│  │  req.user.directories 下：            │                            │
│  │   .cfgsync/<content_type>/            │                            │
│  │     <item_uid>/v<N>.<ext>             │                            │
│  └─────────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────┘
```

**关键结构决策**：SQLite 是整个服务器实例共享的一份数据库（例如放在 `plugins/cfgsync/data/cfgsync.sqlite`），负责跨用户的元数据、权限、审计；实际内容 blob 则分散存放在各用户自己的数据目录下，两者职责分离——元数据关系（谁能读谁的什么）天然是跨用户的，不适合按用户分库；内容文件天然属于某个用户，适合放在用户自己的目录里。

---

## 四、ConfigAdapter 设计

### 1. 统一契约

```typescript
interface ConfigAdapter {
  contentType: string;

  // 发现该类型下当前有哪些可同步对象
  listItems(directories): Promise<{ itemUid, displayName, sourceRef }[]>;

  // 读取 ST 侧当前内容
  read(directories, itemUid): Promise<RawContent>;

  // 统一的写操作入口：UPSERT 写回 ST，DELETE 从 ST 中移除
  apply(directories, itemUid, operation: 'UPSERT' | 'DELETE', content?: RawContent): Promise<void>;

  // 序列化为可存储的 blob
  serialize(content: RawContent): { buffer: Buffer, mimeType: string, ext: string };

  // 从 blob 反序列化
  deserialize(buffer: Buffer, mimeType: string): RawContent;

  // 生成用于 checksum 计算的规范化字节序列（消除 JSON key 顺序等无意义差异）
  canonicalize(content: RawContent): Buffer;

  // 基本校验
  validate(content: RawContent): boolean;

  // pull/delete 完成后如何让 ST 前端感知更新
  getReloadStrategy(): 'reload-settings' | 'reload-preset-list' | 'reload-world-info'
                      | 'refresh-character-list' | 'refresh-background-cache' | ...;
}
```

`checksum` 一律基于 `canonicalize()` 的输出计算，而不是直接对原始序列化字节串取哈希，避免同一内容因 JSON key 顺序不同在不同设备上产生不同 checksum、触发虚假冲突。

**`checksum` 的定位需要明确**：它只用于变更检测和一致性比对，不是防篡改签名——任何客户端都可以拿任意内容配上匹配的 checksum 发起请求，真正阻止非法写入的是鉴权（`req.user`）+ 权限判断（`AuthorizationService`）+ 原子 CAS，不是 checksum 本身。

### 2. 按开发阶段分组

| 分组 | content type | 存储 | 说明 |
|---|---|---|---|
| **P0（第一期）** | `settings`、`openai_preset`、`textgen_preset`、`novel_preset`、`kobold_preset`、`world` | 纯 JSON | 共用一个 JSON adapter，`canonicalize` 做稳定 key 排序 |
| **P1（第二期）** | `character`（仅卡片主体数据，先不含头像图）、`instruct`、`context`、`sysprompt`、`reasoning`、`quick_replies` | JSON 为主 | `character` 数据边界（是否含关联世界书/正则脚本引用）需在实现前单独定义 |
| **P2（第三期）** | `background`、`avatar`、`sprites`、`theme`、`workflow`，及 `character` 补充头像图 | 二进制 | 实现通用 `BinaryAdapter`（原样字节 + mimeType），复用同一套 `ConfigAdapter` 接口和 `SnapshotStore` |

---

## 五、`item_uid` 与对象身份

```javascript
function makeItemUid(contentType, sourceRef) {
  return sha256(`${contentType}:${sourceRef}`).digest('hex'); // 完整 256 位，不截断
}
```

- `item_uid`：内部标识，用于数据库主键和文件路径，定长十六进制字符串，天然不含 `/`、`..` 等危险字符，路径穿越风险在设计层面即不成立。
- `display_name`：用户可见名称，随内容变化可更新，不影响 `item_uid`。
- `source_ref`：该对象在 ST 内部的稳定引用（文件名/路径等），由对应 `ConfigAdapter.listItems()` 提供。

**准确定位**：`item_uid` 是"在当前 adapter 身份识别规则下保持稳定的内部对象标识"，不是绝对意义上永不改变的对象身份——如果底层引用方式变化（比如文件被删除重建、重命名导致引用变了），会产生新的 `item_uid`，旧对象的历史版本保留但不再出现在最新列表中，不主动物理删除，避免误删用户可能还想找回的记录。

---

## 六、数据模型设计

### 服务端（SQLite，服务器级共享一份）

**1. `config_records`**（每个对象的当前状态，含软删除标记）
| 字段 | 说明 |
|---|---|
| owner_handle / content_type / item_uid | 主键三元组 |
| display_name | 当前显示名（冗余存储） |
| current_version | 当前版本号，`0` 表示对象尚不存在实际版本 |
| current_checksum | 基于 canonicalize 输出计算 |
| mime_type / ext | 存储格式信息 |
| is_deleted | 软删除标记（tombstone），删除不等于物理清空历史 |
| updated_at / updated_by_client | 最后更新时间/客户端实例 |

**2. `config_versions`**（append-only 历史，默认每对象保留最近 20 个版本）
| 字段 | 说明 |
|---|---|
| owner_handle / content_type / item_uid / version | 定位 |
| operation | `UPSERT` / `DELETE`（tombstone 版本） |
| checksum / mime_type / ext | 内容元信息（DELETE 版本可为空） |
| blob_path | 实际存储路径（DELETE 版本无 blob） |
| created_at / created_by_client | 创建信息 |

**3. `change_events`**（全局变更序列）
| 字段 | 说明 |
|---|---|
| seq | 全局自增，仅作游标使用，**不代表全局可见** |
| owner_handle / content_type / item_uid / version / operation | 变更对象及类型 |
| created_at | 时间 |

**4. `share_grants`**
| 字段 | 说明 |
|---|---|
| owner_handle / grantee_handle | 授权双方（grantee 分享码认领前可空） |
| scope_type | `ITEM`（单个对象） / `CONTENT_TYPE`（该类型下全部，含未来新增） |
| content_type / item_uid | `scope_type=ITEM` 时 item_uid 有值；`CONTENT_TYPE` 时为空 |
| permission | 第一版只开放 `read` |
| grant_method | `code` / `approval` |
| share_code_hash | 哈希存储，不存明文 |
| code_usage | `single_use` / `multi_use` |
| code_used | 布尔，配合原子 UPDATE 防并发重复领取 |
| status / expires_at | 状态/过期时间 |

**5. `share_requests`**（审批模式）：`requester_handle`/`owner_handle`/`content_type`/`item_uid`/`status`/`message`，字段含义不变。

**6. `audit_logs`**：`actor_handle`/`action`（含 `read`/`push`/`delete`/`rollback`/`grant`/`revoke`/`approve`/`reject`/`claim_code`）/`target_handle`/`content_type`/`item_uid`/`result`/`client_instance_id`/`created_at`。

### 客户端（IndexedDB，服务端不落地，按 `account_handle` 隔离）

**账号隔离原则**：IndexedDB 中所有本插件相关的存储，主键都必须携带当前登录的 `account_handle`。切换 ST 账号后，插件只能读取到当前账号名下的记录，避免同一浏览器多账号切换时数据串线。

**`client_instance_id`**：每个浏览器/客户端实例首次使用本插件时生成一个 UUID 并持久化在 `localStorage`（与账号无关，代表"这台设备/这个浏览器"），仅用于展示"我的设备列表"、区分不同来源的写入记录、排查问题，**绝不作为任何安全边界或权限判断依据**。

**`sync_bindings`**（同步绑定状态）
| 字段 | 说明 |
|---|---|
| binding_uid | `sha256(account_handle + source_owner_handle + content_type + item_uid)`，主键 |
| account_handle | 当前登录账号 |
| content_type / item_uid | 对象定位 |
| source_owner_handle | 配置实际来源——同步自己的就是自己账号，跨账号分享就是对方账号 |
| sync_mode | `OWN`（自己的，可读写） / `SHARED_READONLY`（他人分享，只读） |
| grant_id | `SHARED_READONLY` 时关联的 `share_grants` id |
| enabled | 本设备是否开启该绑定的同步 |
| state | `DISABLED` / `BACKUP_CREATED` / `SYNCED` / `CONFLICT` / `DISABLED_RESTORED` |
| last_notified_version | 轮询得知的云端最新版本（"我知道有更新"） |
| last_synced_version | 本设备实际同步到的版本（"我本地就是这个版本"） |
| last_synced_checksum | 本设备实际同步到的内容 checksum |
| local_backup_ref | 关联的 `local_backup.binding_uid` |
| updated_at | 时间 |

`last_notified_version` 与 `last_synced_version` 分离是必要的：轮询让客户端"知道"云端有新版本，不代表用户已经点击同步、本地内容已经更新。

**`local_backup`**
| 字段 | 说明 |
|---|---|
| binding_uid | 关联 `sync_bindings`，而不是单纯 `content_type+item_uid`（避免自己的对象和他人分享的对象因 `item_uid` 恰好相同而互相覆盖备份） |
| snapshot_content | 开启同步前的本地原始内容 |
| created_at | 时间 |

**`last_acked_seq`**：按 `account_handle` 存一个值，语义是"已经成功处理完的变更事件游标"，不是"已经收到的游标"——轮询拿到一批事件后，必须等客户端逐条处理完成（写入本地提示状态等）才推进这个值，避免处理到一半崩溃导致中间事件永久丢失。

---

## 七、权限模型

```javascript
const Permission = { READ: 'read', WRITE: 'write', ROLLBACK: 'rollback', SHARE: 'share', APPROVE: 'approve' };

function can(action, requesterHandle, ownerHandle, contentType, itemUid) {
  if (requesterHandle === ownerHandle) return true; // 所有者对自己的对象拥有全部权限
  if (action !== Permission.READ) return false;      // 第一版：跨账号只可能拥有 READ

  return hasApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid);
  // 匹配 scope_type=ITEM 且 item_uid 相同，或 scope_type=CONTENT_TYPE 且 content_type 相同
}
```

- `requesterHandle` 一律来自 `AuthContext.fromRequest(req).handle`，绝不信任请求体/查询参数里的身份声明。
- `push`/`rollback`/`delete` 内部先过 `can(WRITE/ROLLBACK, ...)`。
- **`CONTENT_TYPE` 范围授权的隐私含义需要在 UI 里说清楚**：这种授权允许被授权方通过 `/items` 枚举该类型下全部对象的名称列表（不只是读取内容），因为"全部，含未来新增"本身就意味着对方可以看到有哪些对象存在。分享界面文案应明确写出"对方将能看到你在【该类型】下的全部对象名称，而不仅是某一个"，避免用户以为只授权了"某种类型的读取能力"而没意识到还包含了列表可见性。
- 撤销授权只影响未来的 `can()` 判断，不追溯清除对方本地已下载的内容，UI 需明确告知。

---

## 八、同步引擎：创建 / 更新 / 删除 / 回滚的统一实现

所有写路径（首次创建、更新、删除、回滚）最终都收敛到同一条"生成新版本"的逻辑，区别只在于 `operation` 和内容来源，这样 `SyncService` 不需要为每种场景写特殊分支。

### 1. 请求结构

```json
POST /push
{
  "content_type": "openai_preset",
  "item_uid": "…",
  "base_version": 0,
  "operation": "UPSERT",
  "checksum": "…",
  "payload": "…"
}
```
- `base_version = 0` 明确代表"我认为这个对象目前不存在"，是首次创建的合法输入，不是错误。
- `operation` 为 `UPSERT` 或 `DELETE`；`DELETE` 时不需要 `payload`。
- `rollback` 内部构造一个等价请求：`operation=UPSERT`，`payload` 取自目标历史版本的内容，`base_version` 为调用时的当前版本，同样走下面的 CAS 流程。

### 2. 服务端处理流程

```
1. AuthContext 取得 requesterHandle
2. can(WRITE 或 ROLLBACK, requesterHandle, owner, content_type, item_uid) 校验
3. validate(payload)（UPSERT 时）
4. 若 base_version = 0：
     尝试 INSERT config_records(..., current_version=0) ON CONFLICT(owner, content_type, item_uid) DO NOTHING
     （用于把"对象是否已存在"这件事本身也纳入原子操作，避免两台设备同时首次创建时互相踩踏）
5. 写临时 blob → fsync → rename 为正式 blob（DELETE 操作跳过此步）
6. BEGIN IMMEDIATE 事务：
     UPDATE config_records
     SET current_version = current_version + 1,
         current_checksum = @checksum,
         is_deleted = (operation = 'DELETE'),
         updated_at = @now,
         updated_by_client = @clientId
     WHERE owner_handle=@owner AND content_type=@ct AND item_uid=@uid
       AND current_version = @baseVersion
     -- affected_rows = 0 → ROLLBACK 事务，返回 409 Conflict { server_version }
     -- affected_rows = 1 → 继续：
     INSERT INTO config_versions (..., operation, blob_path, checksum, ...)
     INSERT INTO change_events (..., operation, version, ...)
   COMMIT
7. 若第 6 步事务失败（而不是正常的 409），第 5 步写入的 blob 成为孤儿文件，
   由后台定期清理任务按"无对应 config_versions 记录"规则清理
```

`affected_rows = 0` 的两种可能（对象已存在但版本不符 / 对象在第 4 步已被别的请求抢先创建）都统一归为 409，客户端收到后重新 `GET` 当前版本，按需重试或提示用户处理冲突，不需要在协议层区分这两种情况。

### 3. 冲突提示

前端收到 409 后展示三选一：
> 云端该配置已被其它设备更新（当前版本 {server_version}）。
> [拉取云端最新版本覆盖本地] [仍然覆盖云端（不推荐）] [取消，稍后手动处理]

第一版不做自动 diff/合并，对应 `sync_bindings.state` 进入 `CONFLICT`，直到用户选择前两个选项之一才回到 `SYNCED`。

---

## 九、变更事件（`ChangeEventBus`）

### 1. 可见性过滤（修复此前遗漏的越权问题）

```
GET /changes?since=<last_acked_seq>

服务端查询：
SELECT * FROM change_events
WHERE seq > :since
  AND (
    owner_handle = :requester
    OR EXISTS（该 owner_handle+content_type[+item_uid] 上，
               requester 当前存在 approved 的 share_grants 记录）
  )
ORDER BY seq
```
只返回请求方当前有权限查看的事件，不做"先返回全部再让客户端自己过滤"的设计。已过期或已撤销的授权不再使该 owner 的事件对 requester 可见。

**不补发授权生效前的历史事件**：如果 Alice 在 seq=110 才获得对 Bob 某对象的读权限，即便该对象在 seq=100 已经变更过，`/changes` 也不需要向 Alice 补发 seq=100 那条事件——她真正需要的是"当前最新是哪个版本"，可以直接通过 `/pull` 拿到，不必重放历史通知。

### 2. 去重

同一 `owner+content_type+item_uid` 在 `since` 之后如果发生了多次变更，`/changes` 只返回其中版本号最大的一条，不逐条返回中间版本，避免短时间高频写入时轮询响应体膨胀。

### 3. 客户端游标推进

客户端拉到一批事件后，逐条更新对应 `sync_bindings.last_notified_version`（仅此而已，不自动同步内容），**全部处理完成后**才把 `last_acked_seq` 推进到本次响应中的最大 `seq`。如果处理到一半页面崩溃/关闭，下次启动仍从旧的 `last_acked_seq` 开始，不会丢事件（可能重复处理，但重复处理幂等，不影响正确性）。

---

## 十、前端扩展 UI 设计

1. **同步配置面板**：按 content type 分组（P0 优先），组内按对象列出，勾选开关写入本地 `sync_bindings`（`sync_mode=OWN`）。关闭开关时按第十一节流程处理本地回退。
2. **分享管理面板**：生成分享码（范围可选单个对象或整个类型，类型范围需展示"含未来新增对象名称也将对被授权方可见"的说明）/ 认领分享码 / 审批列表 / 我的分享+撤销（撤销按钮旁标注"已下载内容无法追溯收回"）。认领的对象在同步面板中以 `SHARED_READONLY` 标签展示，不出现"上传"相关按钮。
3. **变更提示条**：非打扰式提示"[xxx] 有新版本可同步"，点击后 `pull` 并推进 `last_synced_version`。
4. **历史版本面板**：仅 owner 可见"回滚到此版本"按钮。
5. **冲突提示**：`sync_bindings.state=CONFLICT` 时在对应对象旁显式标红，提供第八节所述三选一操作。

---

## 十一、本地回退设计

- 首次为某绑定开启同步：读取当前本地内容 → 写入 `local_backup`（关联 `binding_uid`）→ `sync_bindings.state = BACKUP_CREATED` → 首次同步成功后转为 `SYNCED`。
- 关闭同步开关：弹窗确认"是否恢复为开启同步前的本地版本"，确认后用 `local_backup` 覆盖当前内容，调用对应 `ConfigAdapter.getReloadStrategy()` 让 ST 前端重新加载，`state` 转为 `DISABLED_RESTORED`。
- 若该绑定从未产生过备份（无 `local_backup`），关闭同步时明确提示"无可回退版本，关闭同步将保留当前内容"。
- 重新开启同步时，若当前处于 `DISABLED_RESTORED`，视为全新一次开启，重新生成备份，不复用旧备份。
- **云端删除的处理**：`/changes` 感知到某对象被删除后，前端提示"云端对象已被删除"，本地默认解除该绑定的 `enabled`（停止继续同步），但**不主动清除 `local_backup`**——用户仍可以像"关闭同步"一样选择恢复到本地原始内容。

---

## 十二、API 接口设计

前缀：`/api/plugins/cfgsync`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/content-types` | 支持的 content type 清单（含 P0/P1/P2 分组） |
| GET | `/items?content_type=&owner=` | 列出对象（`item_uid`+`display_name`），跨账号需 READ 权限，未过滤到无权限对象 |
| GET | `/pull?content_type=&item_uid=&owner=` | 拉取指定对象内容 |
| POST | `/push` | 见第八节，支持创建/更新/删除，原子 CAS |
| GET | `/changes?since=` | 见第九节，按可见范围过滤 + 去重 |
| GET | `/versions?content_type=&item_uid=&owner=` | 历史版本列表 |
| POST | `/rollback` | 仅 owner，内部等价于一次特殊的 `/push`，同样走 CAS |
| GET | `/shares/outgoing` / `/shares/incoming` | 授权列表 |
| POST | `/shares/create-code` | 生成分享码（`scope_type`/范围/一次性或多次性/有效期），明文只返回一次 |
| POST | `/shares/claim-code` | 认领分享码，`single_use` 走原子 UPDATE 防并发重复领取 |
| POST | `/shares/revoke` | 撤销授权 |
| GET | `/requests/pending` / POST `/requests/create` / `/requests/approve` / `/requests/reject` | 审批流程 |
| GET | `/audit?scope=self` | 与自己相关的审计记录 |

同步开关（`preferences`）不再是服务端接口——完全由客户端 `sync_bindings` 维护，服务端只需判断"这个请求方是否是 owner 或已被授权"，不需要知道任何设备的开关状态。

---

## 十三、安全与风险控制

- `req.user` 一律通过 `AuthContext.fromRequest(req)` 获取，代码中禁止直接访问 `req.user.xxx`，隔离未来 ST 内部结构变化的影响。
- `item_uid` 为完整 SHA-256 十六进制字符串，从设计上避免路径穿越，不依赖额外白名单校验。
- `share_code` 数据库只存哈希（类比密码存储），生成时明文仅展示给 owner 一次；`claim-code` 接口加频率限制（`attempt_count`/`last_attempt_at`）。
- `push`/`rollback`/`claim-code` 等涉及状态变更的操作全部走数据库层原子 CAS/条件 UPDATE，不使用"先读后写"的应用层竞态代码。
- `/changes` 严格按请求方当前权限过滤，不返回无关账号的活动元数据。
- `CONTENT_TYPE` 范围授权的"可枚举对象列表"隐私含义在 UI 文案中明确告知。
- IndexedDB 全部数据按 `account_handle` 隔离，切换账号后不可见前一账号的数据。
- Server Plugin 不沙箱化，只从可信来源安装，代码经过基本审查；对 ST 内部模块的依赖集中在适配层。
- 审计日志覆盖跨账号读取、授权发放/撤销、审批、回滚等操作。

---

## 十四、开发阶段与里程碑

**第一期 · 核心同步引擎（P0 类型 + 完整 CAS 生命周期 + 本地回退 + 轮询）**
- `ConfigAdapter` 实现 `settings`/各类 preset/`world`（JSON，含 `canonicalize`）
- `config_records`/`config_versions`/`change_events` 三张表 + 统一的创建/更新/删除/回滚写路径（第八节）
- `/changes` 权限过滤 + 去重（第九节）
- 客户端 `sync_bindings`/`local_backup`（按账号隔离）+ 本地回退
- 验收标准：
  1. 全新对象首次 `push` 成功创建（`base_version=0`）
  2. 两台设备同时首次创建同一对象，只有一个成功，另一个收到 409
  3. 两台设备并发修改已存在对象，后到的请求收到 409，不发生静默覆盖
  4. 对象被删除后，长期离线设备重新上线不会使其复活
  5. 关闭同步开关能正确回退到本地开启前版本
  6. 同一浏览器切换账号后，看不到前一账号的 `sync_bindings`/`local_backup`
  7. 轮询处理到一半模拟崩溃，重启后能从未确认的位置继续，不丢事件

**第二期 · 跨账号授权（分享码+审批）+ P1 类型 + 审计**
- `share_grants`（`scope_type`区分、哈希分享码、`single_use` 原子领取）/`share_requests`/`audit_logs`
- `ConfigAdapter` 补齐 `character`（先不含头像图）、`instruct`、`context` 等
- `rollback` 走统一 CAS 路径
- 验收标准：
  1. 两种授权模式全流程可用
  2. 越权操作（含篡改 `owner` 参数、`/changes` 尝试查看无权限账号事件）一律拒绝并计入审计
  3. `single_use` 分享码并发领取只有一方成功
  4. `rollback` 与并发 `push` 竞争时能正确产生 409

**第三期 · 二进制资源类型（P2）+ WebSocket 评估 + 打磨**
- `BinaryAdapter` 覆盖 `background`/`avatar`/`sprites`/`theme`/`workflow`，`character` 补齐头像图
- 评估独立 WS 端口 + 独立鉴权（一次性 token 交换）的实际投入产出比，决定是否接入；若不接入，轮询继续作为正式方案
- 性能与安全测试、文档完善

---

## 十五、已知待确认事项（不阻塞开工，开发中明确即可）

1. `character` 的"卡片主体数据"边界（是否含关联世界书引用、正则脚本等）在实现 P1 阶段 adapter 前需要具体定义。
2. `CONTENT_TYPE` 范围分享是否需要提供"仅授权当前已有对象，不含未来新增"的选项，当前默认只支持"含未来新增"，如有需要可在第二期补充为 `scope_type` 的第三种取值。
3. 历史版本保留数量（默认 20）上线后可按实际存储占用调整。

---

*本文档为 v0.5 定稿版，整合三轮架构审核的全部 P0/P1 修复：本地回退职责分离、冲突检测前移、content type 对齐官方清单并区分存储格式、`item_uid` 与显示名解耦、`sync_bindings` 补全、原子 CAS 覆盖创建/更新/删除/回滚全生命周期、`/changes` 权限过滤与去重、IndexedDB 按账号隔离、checksum 规范化、分享码哈希存储。核心架构与数据模型已闭环，可以开始第一期编码。*
