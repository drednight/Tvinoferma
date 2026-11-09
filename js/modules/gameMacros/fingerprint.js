import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export function commandFingerprint(command, config) {
  const {
    action,
    sequence,
    blocks,
    partyId,
    target,
    charIds,
    scope,
    backgroundMethod,
    delivery,
    holdMs,
    switchMs,
    pointId,
    pointIds,
    button,
    count,
    modifiers,
    returnTo,
    profileId,
    width,
    height
  } = command;
  const plan = JSON.stringify({
    action,
    sequence,
    blocks,
    partyId,
    target,
    charIds,
    scope,
    backgroundMethod,
    delivery,
    holdMs,
    switchMs,
    pointId,
    pointIds,
    button,
    count,
    modifiers,
    returnTo,
    profileId,
    width,
    height,
    context: config
      ? {
          partyId: config.partyId,
          leaders: config.leaders,
          points: config.points,
          profiles: config.profiles,
          referencedCommands: config.commands
            .filter(row => row.id !== command.id)
            .map(row => ({ id: row.id, plan: commandFingerprint(row) }))
        }
      : undefined
  });
  return bytesToHex(sha256(new TextEncoder().encode(plan)));
}
