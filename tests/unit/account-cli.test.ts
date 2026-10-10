import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { hiddenInput } from '../../apps/server/src/account-cli.js';
function tty() {
  const writes: string[] = [];
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn() });
  const output = { isTTY: true, write: (text: string) => { writes.push(text); } };
  return { input, writes, read: () => hiddenInput('Password (hidden): ', input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream) };
}
describe('interactive account password input', () => {
  it('does not echo input, handles split UTF-8/backspace, and restores terminal mode', async () => {
    const terminal = tty(); const pending = terminal.read(); const bytes = Buffer.from('虚构🙂', 'utf8');
    terminal.input.emit('data', bytes.subarray(0, 2)); terminal.input.emit('data', bytes.subarray(2));
    terminal.input.emit('data', Buffer.from('\u007f\u001b[D-test-password\r'));
    expect(await pending).toBe('虚构-test-password'); expect(terminal.writes).toEqual(['Password (hidden): ', '\n']);
    expect(terminal.input.setRawMode).toHaveBeenLastCalledWith(false); expect(terminal.input.listenerCount('data')).toBe(0);
  });
  it('rejects overlong input without silently truncating it', async () => {
    const terminal = tty(); const pending = terminal.read(); terminal.input.emit('data', Buffer.from('x'.repeat(129) + '\r'));
    await expect(pending).rejects.toThrow('too long'); expect(terminal.writes).toEqual(['Password (hidden): ', '\n']);
  });
  it('restores raw mode and detaches on cancellation', async () => {
    const terminal = tty(); const pending = terminal.read(); terminal.input.emit('data', Buffer.from('fictional\u0003'));
    await expect(pending).rejects.toThrow('Cancelled'); expect(terminal.input.setRawMode).toHaveBeenLastCalledWith(false); expect(terminal.input.listenerCount('data')).toBe(0);
  });
});
