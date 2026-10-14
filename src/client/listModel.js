export const TYPE_LABELS = Object.freeze({
  world: '世界书', openai_preset: '对话预设', character: '角色卡', settings: '通用设置',
  persona: '用户人设', avatar: '人设头像', chat: '会话记录', group: '群组', group_chat: '群聊记录',
  theme: '主题', background: '背景', sprites: '表情贴图', quick_replies: '快捷回复',
  instruct: '指令模板', context: '上下文模板', sysprompt: '系统提示词',
  textgen_preset: '文本生成预设', novel_preset: 'Novel 预设', kobold_preset: 'Kobold 预设',
});
export const itemKey = (owner, uid) => `${owner}:${uid}`;
export const bindingKey = (owner, type, uid) => `${owner}:${type}:${uid}`;
export function isOwnBinding(binding, account) {
  return (!binding.source_owner_handle || binding.source_owner_handle === account)
    && binding.sync_mode !== 'SHARED_READONLY' && binding.sync_mode !== 'SUBSCRIBE';
}

/** Keep each owner's cloud object separate even when filenames produce the same UID. */
export function buildItemList(localItems, cloudItems, account) {
  const localByUid = new Map(localItems.map(item => [item.itemUid, item]));
  const items = new Map(localItems.map(item => [itemKey(account, item.itemUid), {
    ...item, sourceOwner: account, existsLocally: true, cloudItem: null,
  }]));
  for (const cloud of cloudItems) {
    const owner = cloud.owner_handle || account;
    const key = itemKey(owner, cloud.item_uid);
    const local = localByUid.get(cloud.item_uid);
    items.set(key, {
      ...(items.get(key) || local || {}), itemUid: cloud.item_uid,
      displayName: cloud.display_name, sourceOwner: owner,
      sourceRef: local?.sourceRef || `来自云端 (@${owner})`,
      existsLocally: Boolean(local), cloudItem: cloud,
    });
  }
  return [...items.values()].sort((a,b) => Number(Boolean(b.cloudItem)) - Number(Boolean(a.cloudItem))
    || (a.displayName || '').localeCompare(b.displayName || '', 'zh-CN')
    || a.sourceOwner.localeCompare(b.sourceOwner));
}
