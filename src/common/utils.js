import crypto from 'node:crypto';

/**
 * 计算给定数据的 SHA-256 哈希十六进制字符串（64位长）
 * @param {Buffer | string} input
 * @returns {string}
 */
export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * 递归规范化对象属性顺序（按字母升序），以消除 JSON 序列化时 key 乱序导致的哈希抖动
 * @param {any} value
 * @returns {any}
 */
export function canonicalizeValue(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const sortedKeys = Object.keys(value).sort();
  const sortedObj = {};
  for (const key of sortedKeys) {
    if (value[key] !== undefined) {
      sortedObj[key] = canonicalizeValue(value[key]);
    }
  }
  return sortedObj;
}

/**
 * 生成用于 checksum 比对的稳定 Buffer
 * @param {any} content
 * @returns {Buffer}
 */
export function canonicalizeJson(content) {
  const normalized = canonicalizeValue(content);
  const jsonStr = JSON.stringify(normalized);
  return Buffer.from(jsonStr, 'utf8');
}

/**
 * 计算规范化后的 Checksum
 * @param {any} content
 * @returns {string}
 */
export function calcJsonChecksum(content) {
  const buf = canonicalizeJson(content);
  return sha256(buf);
}

/**
 * 计算对象稳定全局标识符 item_uid
 * 规则：sha256(`${contentType}:${sourceRef}`) 完整 256 位十六进制
 * @param {string} contentType
 * @param {string} sourceRef
 * @returns {string}
 */
export function makeItemUid(contentType, sourceRef) {
  if (!contentType || !sourceRef) {
    throw new Error('contentType and sourceRef are required to generate itemUid');
  }
  return sha256(`${contentType}:${sourceRef}`);
}
