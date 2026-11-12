import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync('src-tauri/src/game_macros.rs', 'utf8');
it('keeps the experimental native command separately gated and arbitrated', () => {
  const command = source.slice(
    source.indexOf('pub async fn game_macro_modifier_trial('),
    source.indexOf('pub async fn game_macro_compare_once(')
  );
  expect(command).toContain('main_only(&window)?');
  expect(command).toContain('validate_modifier_experiment(&key, method, consent, risk_consent)?');
  expect(command).toContain('INPUT.acquire("modifier-experiment", epoch)');
  expect(command).toContain('macro_client_at(target.pid, target.started_at, target.hwnd)');
  expect(command).toContain('compatible_integrity');
});
it('records attempted keys before DOWN and always reaches explicit and unwind UP cleanup', () => {
  const protocol = source.slice(
    source.indexOf('struct ModifierTrialKeys'),
    source.indexOf('pub fn comparison_foreground()')
  );
  expect(protocol.indexOf('self.global.push(vk)')).toBeLessThan(protocol.indexOf('Self::global_event(vk, false)'));
  expect(protocol).toContain('impl Drop for ModifierTrialKeys');
  expect(protocol).toContain('keys.addressed = Some((vk, scan, alt))');
  expect(protocol).toContain('let released = keys.release(&mut steps)');
  expect(protocol).toContain('MODIFIER_TRIAL_BLOCKED.store(true');
  expect(protocol).toContain('eq_ignore_ascii_case("Notepad")');
  expect(protocol).not.toMatch(/AttachThreadInput|SetKeyboardState/);
  expect(protocol).toContain('BackgroundMethod::SendTimeout');
});
it('uses left Ctrl/Alt/Shift with reverse cleanup, Alt context on addressed DOWN and UP, and extended global keys', () => {
  const protocol = source.slice(
    source.indexOf('struct ModifierTrialKeys'),
    source.indexOf('pub fn comparison_foreground()')
  );
  expect(protocol).toContain('0x10 => 0xa0');
  expect(protocol).toContain('0x11 => 0xa2');
  expect(protocol).toContain('for modifier in &globals');
  expect(protocol).toContain('self.global.pop()');
  expect(protocol).toContain('background_key_message(vk, scan, false, alt)');
  expect(protocol.match(/background_key_message\(vk, scan, true, alt\)/g)).toHaveLength(2);
  expect(protocol).toContain('KEYEVENTF_EXTENDEDKEY');
});
it('party mode requires a separately verified leader and never uses focus activation', () => {
  const command = source.slice(
    source.indexOf('pub async fn game_macro_modifier_trial('),
    source.indexOf('pub async fn game_macro_compare_once(')
  );
  expect(command).toContain('source.as_ref().ok_or("Party leader source required")?');
  expect(command).toContain('macro_client_at(source.pid, source.started_at, source.hwnd)');
  const protocol = source.slice(
    source.indexOf('pub fn modifier_experiment('),
    source.indexOf('pub fn comparison_foreground()')
  );
  expect(protocol).toContain('verified_window(leader_raw, leader_pid)? != original');
  expect(protocol).toContain('else if method == ModifierExperiment::Activate');
  expect(protocol).toContain('method == ModifierExperiment::HybridParty && original != hwnd');
});
