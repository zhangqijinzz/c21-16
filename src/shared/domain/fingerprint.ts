/**
 * 通用的稳定序列化与内容指纹。
 * 指纹用途：为没有修订号的旧版裸文档派生确定性“修订号”，
 * IDB 服务的 CAS 比对与 repository 的信封升级必须算出同一个值。
 */

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function legacyFingerprint(raw: unknown): string {
  let hash = 0x811c9dc5;
  const text = stableStringify(raw);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `legacy-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
