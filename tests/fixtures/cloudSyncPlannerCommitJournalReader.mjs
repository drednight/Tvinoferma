// Дочерний процесс теста Linux: получает только вымышленные данные и доверенные отметки через stdin.
// Здесь нет native/Tauri, блокировок, атомарной записи или проверки физического fsync.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import process from 'node:process';
import { verifyHistory } from '../../js/modules/cloudSync/history.js';
import {
  inspectPlannerCommitIntent,
  readPublishedPlannerCommitIntent
} from '../../js/modules/cloudSync/plannerCommitJournal.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const history = await verifyHistory({
  envelopes: input.versions.map(version => version.envelope),
  root: input.rootPin,
  knownPins: input.knownPins,
  expectedDatasetId: input.datasetId,
  recoveryKey: input.datasetKey,
  cryptoSource: webcrypto
});
const storage = {
  getItem() {
    return readFileSync(input.slotPath, 'utf8');
  },
  setItem() {
    throw new Error('Тестовый читатель не пишет');
  }
};
const envelope = await readPublishedPlannerCommitIntent({
  storage,
  datasetId: input.datasetId,
  deviceId: input.deviceId,
  expectedIntentPin: input.intentPin,
  cryptoSource: webcrypto
});
const result = await inspectPlannerCommitIntent({
  envelope,
  expectedIntentPin: input.intentPin,
  stateRaw: readFileSync(input.statePath, 'utf8'),
  checkpointRaw: readFileSync(input.checkpointPath, 'utf8'),
  history,
  datasetId: input.datasetId,
  deviceId: input.deviceId,
  rootPin: input.rootPin,
  localBeforePin: input.localPin,
  remotePin: input.remotePin,
  expectedCheckpointBeforePin: input.checkpointBeforePin,
  expectedKnownPins: input.knownPins,
  checkpointKey: input.checkpointKey,
  intentKey: input.intentKey,
  cryptoSource: webcrypto
});
process.stdout.write(JSON.stringify(result));
