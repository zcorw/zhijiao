import { partialDateSchema } from '@zhijiao/shared';
import type { GenericValidateFunction } from 'vee-validate';
import { toDateTimePicker } from './datetime-picker';

export type FormRule = GenericValidateFunction<unknown>;
const text = (value: unknown) => typeof value === 'string' ? value : '';
export const requiredText = (label: string, max = 100_000): FormRule => value =>
  !text(value).trim() ? `请填写${label}。` : text(value).length > max ? `${label}最多 ${max} 个字符。` : true;
export const optionalText = (label: string, max = 100_000): FormRule => value =>
  text(value).length > max ? `${label}最多 ${max} 个字符。` : true;
export const interactionContentRule = (title: string): FormRule => value =>
  text(value).length > 100_000 ? '事件或感受最多 100000 个字符。'
    : !!(title.trim() || text(value).trim()) || '请写下事件或感受，也可以只填写交往标题。';
export const loginRule: FormRule = value => {
  const login = text(value).trim().toLowerCase();
  if (!login) return '请填写登录名。';
  return login.length >= 3 && login.length <= 120 && /^[a-z0-9@._+-]+$/.test(login)
    ? true : '登录名为 3–120 个字符，可用英文字母、数字和 @ . _ + -。';
};
export const loginPasswordRule: FormRule = value => !text(value) ? '请填写登录密码。'
  : text(value).length >= 8 && text(value).length <= 128 ? true : '登录密码需为 8–128 个字符。';
const checkPassphrase = (value: unknown) => !text(value) ? '请填写资料库解锁口令。'
  : text(value).length >= 12 && text(value).length <= 1024 ? true : '解锁口令需为 12–1024 个字符。';
export const passphraseRule: FormRule = value => checkPassphrase(value);
export const secretRule = (recovery: boolean): FormRule => value => recovery
  ? /^ZJ1-[A-Za-z0-9_-]{43}$/.test(text(value)) || '请填写完整的独立恢复秘密（以 ZJ1- 开头）。'
  : checkPassphrase(value);
export const matches = (getOriginal: () => string): FormRule => value => !text(value)
  ? '请再次输入解锁口令。' : text(value) === getOriginal() || '两次输入的口令不一致。';
export const partialDateRule = (label: string): FormRule => value => !text(value).trim()
  || partialDateSchema.safeParse(text(value).trim()).success
  || `${label}不合法。可填 YYYY、YYYY-MM、YYYY-MM-DD 或 --MM-DD。`;
export const datetimeRule: FormRule = value => !text(value).trim() || toDateTimePicker(text(value).trim()) !== null || '请填写合法的日期和时间（YYYY-MM-DDTHH:mm，24 小时制）。';
export const timezoneRule = (required: () => boolean): FormRule => value => {
  if (!text(value).trim()) return !required() || '填写精确时间时，请同时填写时区。';
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: text(value).trim() }); return true; }
  catch { return '请填写有效时区，如 Asia/Shanghai。'; }
};
export const peopleRule: FormRule = value => Array.isArray(value) && value.length > 0 || '请选择至少一位人物。';
export const confirmationRule: FormRule = value => value === true || '请先勾选确认，再继续。';

/** Open collapsed details before focusing; never focus on ordinary blur validation. */
export function focusFirstError(form: HTMLFormElement | undefined) {
  const input = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!input) return;
  let parent = input.parentElement;
  while (parent && parent !== form) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: 'center', behavior: 'auto' });
}
