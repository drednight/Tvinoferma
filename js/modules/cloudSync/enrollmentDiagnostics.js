// Strictly fixed codes/stages. Never stringify an OAuth result or native error.
export const ENROLLMENT_STAGES = Object.freeze({
  checking_local: 'oauth_local',
  browser: 'oauth_browser',
  waiting: 'oauth_waiting',
  token: 'oauth_token',
  identity: 'oauth_identity',
  identity_binding_mismatch: 'oauth_identity_binding_mismatch',
  confirming: 'oauth_confirmation',
  installing: 'oauth_install',
  verifying_installation: 'oauth_verify_install'
});
export const ENROLLMENT_RESULTS = Object.freeze([
  'installed',
  'installed_refresh_expired',
  'already_configured',
  'installed_access_expired',
  'invalid_input',
  'local_occupied',
  'local_blocked',
  'local_unavailable',
  'installation_uncertain',
  'occupied',
  'expired',
  'denied',
  'cancelled',
  'declined',
  'scope_unverified',
  'refresh_missing',
  'token_unavailable',
  'identity_unverified',
  'account_label_unavailable',
  'account_changed',
  'confirmation_unverified',
  'failed'
]);
export const ENROLLMENT_LOCAL_STATES = Object.freeze([
  'empty',
  'signed_out',
  'ready',
  'ready_bound',
  'configured',
  'pending',
  'blocked',
  'dataset_blocked',
  'dataset_incomplete',
  'unknown_result',
  'unknown',
  'unavailable'
]);
export const ENROLLMENT_DIAGNOSTIC_CODES = Object.freeze([
  ...ENROLLMENT_RESULTS.map(s => 'login_' + s),
  ...ENROLLMENT_LOCAL_STATES.map(s => 'login_local_' + s),
  'login_missing_client_id',
  'registration_only'
]);
