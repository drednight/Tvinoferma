import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  beginDuplicateMergeJournal,
  readDuplicateMergeJournal,
  clearDuplicateMergeJournal
} from '../js/core/duplicateMergeJournal.js';
const name = 'state.backup-123-dup-0123456789abcdef01234567-42-1.json';
const key = 'tf:duplicate-merge-pending-v1';
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('stores only a backup name and date; clears only the same operation', () => {
  const entry = beginDuplicateMergeJournal(name);
  expect(readDuplicateMergeJournal()).toEqual({ status: 'pending', name, at: entry.at });
  expect(JSON.parse(localStorage.getItem(key))).toEqual({ version: 1, name, at: entry.at });
  expect(() => beginDuplicateMergeJournal(name)).toThrow();
  expect(() => clearDuplicateMergeJournal({ ...entry, name: name.replace('123', '124') })).toThrow();
  expect(readDuplicateMergeJournal().status).toBe('pending');
  clearDuplicateMergeJournal(entry);
  expect(readDuplicateMergeJournal()).toEqual({ status: 'none' });
});
it('fails closed on malformed entries, storage errors and readback failure', () => {
  localStorage.setItem(key, '{');
  expect(readDuplicateMergeJournal().status).toBe('invalid');
  expect(() => beginDuplicateMergeJournal(name)).toThrow();
  localStorage.clear();
  expect(() => beginDuplicateMergeJournal('../../contact.json')).toThrow();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('private path');
  });
  expect(readDuplicateMergeJournal().status).toBe('unavailable');
  expect(() => beginDuplicateMergeJournal(name)).toThrow(/отметку/);
});
it('does not report successful removal when the marker remains', () => {
  const entry = beginDuplicateMergeJournal(name);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
  expect(() => clearDuplicateMergeJournal(entry)).toThrow();
  expect(readDuplicateMergeJournal().status).toBe('pending');
});
