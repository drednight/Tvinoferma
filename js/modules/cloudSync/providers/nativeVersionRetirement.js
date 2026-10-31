// @ts-check
// Only scoped trash (never permanent delete). Rust rechecks canonical encrypted-file
// SHA and dataset/path metadata; Google also requires ETag/If-Match. No Yandex CAS.
import { object } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { copyCloudEnvelope, validGoogleId } from './common.js';
export function createNativeVersionRetirement({
  provider,
  invoke,
  accessToken,
  datasetId,
  folderId,
  timeoutMs = 65000
}) {
  return async value => {
    try {
      const input = object(value, ['envelope', 'rootVersionId', 'checkpointVersionId'], ['fileId']);
      const envelope = copyCloudEnvelope(input.envelope, datasetId);
      if (
        !['google', 'yandex'].includes(provider) ||
        typeof invoke !== 'function' ||
        !isSyncId(input.rootVersionId) ||
        !isSyncId(input.checkpointVersionId) ||
        new Set([envelope.versionId, input.rootVersionId, input.checkpointVersionId]).size !== 3 ||
        (provider === 'google' && (!validGoogleId(input.fileId) || !validGoogleId(folderId)))
      )
        return { status: 'not_sent' };
      let timer;
      try {
        const reply = object(
          await Promise.race([
            invoke('cloud_disk_network', {
              args: {
                provider,
                operation: 'retire',
                accessToken,
                datasetId,
                versionId: envelope.versionId,
                rootVersionId: input.rootVersionId,
                checkpointVersionId: input.checkpointVersionId,
                body: JSON.stringify(envelope),
                ...(provider === 'google' ? { fileId: input.fileId, folderId } : {})
              }
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('unconfirmed')), timeoutMs);
            })
          ]),
          ['status', 'body', 'contentType']
        );
        return { status: [200, 202, 204].includes(reply.status) ? 'accepted' : 'unknown' };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { status: 'unknown' };
    }
  };
}
