import { describe, expect, it } from 'vitest';
import { validate } from 'vee-validate';
import { partialDateSchema } from '@zhijiao/shared';
import { passwordSchema } from '@tts-workbench/account-core';
import { confirmationRule, loginPasswordRule, loginRule, matches, partialDateRule, peopleRule, requiredText, secretRule, timezoneRule } from '../../apps/web/src/validation.js';

describe('Chinese form validation and shared schema agreement', () => {
  it('rejects empty and whitespace business values without consuming a valid name', async () => {
    for (const value of ['', ' ', '\t\n']) expect((await validate(value, requiredText('常用称呼', 200))).errors).toEqual(['请填写常用称呼。']);
    expect((await validate(' 小舟 ', requiredText('常用称呼', 200))).valid).toBe(true);
    expect((await validate('舟'.repeat(201), requiredText('常用称呼', 200))).valid).toBe(false);
  });
  it('retains login normalization and password boundaries without trimming secrets', async () => {
    expect((await validate(' Fictional-UI ', loginRule)).valid).toBe(true);
    for (const value of ['ab', '中英文', 'name value']) expect((await validate(value, loginRule)).valid).toBe(false);
    for (const length of [0, 7, 8, 128, 129]) {
      const value = 'x'.repeat(length);
      expect((await validate(value, loginPasswordRule)).valid).toBe(passwordSchema.safeParse(value).success);
    }
    expect((await validate(' fictional passphrase ', matches(() => 'fictional passphrase'))).valid).toBe(false);
  });
  it('uses the canonical partial-date calendar, including unknown-year leap days', async () => {
    for (const value of ['2026', '2026-10', '2024-02-29', '--02-29', '--02-30', '2025-02-29', '2026-13', 'not-a-date']) {
      expect((await validate(value, partialDateRule('生日'))).valid).toBe(partialDateSchema.safeParse(value).success);
    }
    expect((await validate('', partialDateRule('生日'))).valid).toBe(true);
  });
  it('enforces the selected unlock mode and complete recovery-secret format', async () => {
    expect((await validate('fictional vault passphrase', secretRule(false))).valid).toBe(true);
    expect((await validate('short', secretRule(false))).valid).toBe(false);
    expect((await validate('ZJ1-' + 'a'.repeat(43), secretRule(true))).valid).toBe(true);
    for (const value of ['', 'ZJ1-' + 'a'.repeat(42), 'ZJ1-' + 'a'.repeat(44), 'ZJ1-' + '!'.repeat(43)]) expect((await validate(value, secretRule(true))).valid).toBe(false);
  });
  it('requires a zone only for exact times and explicit selected people/confirmation', async () => {
    expect((await validate('', timezoneRule(() => false))).valid).toBe(true);
    expect((await validate('', timezoneRule(() => true))).valid).toBe(false);
    expect((await validate('Asia/Shanghai', timezoneRule(() => true))).valid).toBe(true);
    expect((await validate('unknown/timezone', timezoneRule(() => false))).valid).toBe(false);
    expect((await validate([], peopleRule)).valid).toBe(false);
    expect((await validate(['fictional-person'], peopleRule)).valid).toBe(true);
    expect((await validate(false, confirmationRule)).valid).toBe(false);
    expect((await validate(true, confirmationRule)).valid).toBe(true);
  });
});
