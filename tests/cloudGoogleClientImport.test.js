import { describe, expect, it } from 'vitest';
import {
  googleClientImportProblem,
  GOOGLE_IMPORT_MESSAGES
} from '../js/modules/cloudSync/providers/googleClientImport.js';
const installed = { client_id: '123-example.apps.googleusercontent.com', client_secret: 'FAKE_ONLY_SECRET' };
describe('Google Desktop JSON diagnostics without exposing contents', () => {
  it('accepts original exported metadata and UTF-8 BOM, without trusting imported URLs', () => {
    expect(
      googleClientImportProblem(
        '\uFEFF' +
          JSON.stringify({
            installed: {
              ...installed,
              project_id: 'fake-project',
              auth_uri: 'https://evil.invalid',
              redirect_uris: ['http://localhost']
            }
          })
      )
    ).toBeNull();
  });
  it.each([
    ['{', 'json_syntax'],
    [JSON.stringify({ web: installed }), 'web_client'],
    [JSON.stringify({ type: 'service_account', private_key: 'FAKE_ONLY_SECRET' }), 'not_desktop'],
    [JSON.stringify({ installed: { client_id: installed.client_id } }), 'client_secret'],
    [JSON.stringify({ installed: { ...installed, client_id: 'wrong' } }), 'client_id']
  ])('gives a fixed local reason for an unsupported file', (raw, code) => {
    expect(googleClientImportProblem(raw)).toBe(code);
    expect(GOOGLE_IMPORT_MESSAGES[code]).not.toContain('FAKE_ONLY_SECRET');
  });
});
