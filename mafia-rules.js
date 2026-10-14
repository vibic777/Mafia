'use strict';

const MIN_PLAYERS = 6;
const MAX_PLAYERS = 20;

function mafiaCount(playerCount) {
  return Math.max(1, Math.floor(playerCount / 4));
}

function roleSlots(playerCount, options = {}) {
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new RangeError(`В партии должно быть от ${MIN_PLAYERS} до ${MAX_PLAYERS} игроков`);
  }
  const roles = Array.from({ length: playerCount }, () => ({ role: 'villager', team: 'town' }));
  roles[0] = { role: 'detective', team: 'town' };
  if (playerCount >= 8) roles[1] = { role: 'doctor', team: 'town' };
  for (let i = 0; i < mafiaCount(playerCount); i++) {
    roles[playerCount - 1 - i] = { role: options.testSpecialRoles && playerCount >= 10 && i === 0 ? 'don' : 'mafia', team: 'mafia' };
  }
  if (options.testSpecialRoles && playerCount >= 10) {
    const mayorSlot = playerCount >= 12 ? 2 : 3;
    roles[mayorSlot] = { role: 'mayor', team: 'town' };
  }
  return roles;
}

function winningTeam(players) {
  const alive = players.filter((player) => player.alive);
  const mafia = alive.filter((player) => player.team === 'mafia').length;
  if (mafia === 0) return 'town';
  if (mafia >= alive.length - mafia) return 'mafia';
  return null;
}

function voteLeaders(votes, alivePlayerIds, candidateIds = null, doubleVoteIds = []) {
  const alive = new Set(alivePlayerIds);
  const candidates = candidateIds === null ? null : new Set(candidateIds);
  const doubled = new Set(doubleVoteIds);
  const counts = new Map();
  for (const [voterId, vote] of Object.entries(votes || {})) {
    const targetId = typeof vote === 'string' ? vote : vote?.targetId;
    if (!alive.has(voterId) || !alive.has(targetId) || (candidates && !candidates.has(targetId))) continue;
    const weight = vote && typeof vote === 'object' ? Math.max(1, Number(vote.weight) || 1) : doubled.has(voterId) ? 2 : 1;
    counts.set(targetId, (counts.get(targetId) || 0) + weight);
  }
  const max = Math.max(0, ...counts.values());
  return max ? [...counts].filter(([, count]) => count === max).map(([id]) => id) : [];
}

function doctorCanProtect(actor, target) {
  return Boolean(actor && target && actor.alive && target.alive && actor.role === 'doctor'
    && actor.id !== target.id && actor.lastProtectedId !== target.id);
}

function progressGain({ team, winning, forfeited = false, currentLevel = 0 }) {
  if (forfeited || !team || !['town', 'mafia'].includes(team)) return 0;
  const level = Math.max(0, Math.min(100, Number(currentLevel) || 0));
  return Math.min(100, level + 1 + (team === winning ? 1 : 0)) - level;
}

function isConnected(lastSeenAt, now, timeoutMs) {
  return Number.isFinite(lastSeenAt) && Number.isFinite(now) && Number.isFinite(timeoutMs)
    && now >= lastSeenAt && now - lastSeenAt < timeoutMs;
}

function roleRevealViewers({ players, votes = {}, victimId, cause, visibility }) {
  if (!Array.isArray(players) || !victimId) return [];
  if (cause === 'mafia-kill') {
    if (visibility === 'team') return players.filter((player) => player.team === 'mafia').map((player) => player.id);
    if (visibility === 'killer') return players.filter((player) => player.team === 'mafia' && votes[player.id] === victimId).map((player) => player.id);
    return [];
  }
  if (cause === 'town-vote' && visibility === 'team') return players.filter((player) => player.team === 'town').map((player) => player.id);
  return [];
}

module.exports = { MIN_PLAYERS, MAX_PLAYERS, mafiaCount, roleSlots, winningTeam, voteLeaders, doctorCanProtect, progressGain, isConnected, roleRevealViewers };
