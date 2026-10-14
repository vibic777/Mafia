'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MIN_PLAYERS, MAX_PLAYERS, mafiaCount, roleSlots, winningTeam, voteLeaders, doctorCanProtect, progressGain, isConnected, roleRevealViewers } = require('../mafia-rules');

test('room size is restricted to the documented 6–20 players', () => {
  assert.equal(MIN_PLAYERS, 6);
  assert.equal(MAX_PLAYERS, 20);
  assert.throws(() => roleSlots(5), RangeError);
  assert.throws(() => roleSlots(21), RangeError);
  assert.throws(() => roleSlots(6.5), RangeError);
});

test('role composition has one detective, doctor from 8 players, and the configured mafia count', () => {
  for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
    const roles = roleSlots(count);
    assert.equal(roles.length, count);
    assert.equal(roles.filter((role) => role.role === 'detective').length, 1, `${count} players`);
    assert.equal(roles.filter((role) => role.role === 'doctor').length, count >= 8 ? 1 : 0, `${count} players`);
    assert.equal(roles.filter((role) => role.team === 'mafia').length, Math.max(1, Math.floor(count / 4)), `${count} players`);
    assert.equal(roles.filter((role) => role.role === 'villager').length,
      count - 1 - (count >= 8 ? 1 : 0) - Math.max(1, Math.floor(count / 4)), `${count} players`);
  }
});

test('test roles add mayor and don from 10 players without changing team counts', () => {
  assert.equal(roleSlots(9, { testSpecialRoles: true }).some((entry) => ['mayor', 'don'].includes(entry.role)), false);
  for (let count = 10; count <= MAX_PLAYERS; count++) {
    const roles = roleSlots(count, { testSpecialRoles: true });
    assert.equal(roles.filter((entry) => entry.role === 'mayor').length, 1);
    assert.equal(roles.filter((entry) => entry.role === 'don').length, 1);
    assert.equal(roles.filter((entry) => entry.team === 'mafia').length, mafiaCount(count));
  }
});

test('weighted votes honor a mayor double vote and keep string votes compatible', () => {
  const leaders = voteLeaders({ a: 'x', b: 'y', c: 'y' }, ['a', 'b', 'c', 'x', 'y'], null, ['a']);
  assert.deepEqual(leaders, ['x', 'y']);
  assert.deepEqual(voteLeaders({ a: 'x', b: 'y' }, ['a', 'b', 'x', 'y'], null, ['a']), ['x']);
});

test('mafia count grows by one per four seats and starts at one', () => {
  assert.equal(mafiaCount(6), 1);
  assert.equal(mafiaCount(7), 1);
  assert.equal(mafiaCount(8), 2);
  assert.equal(mafiaCount(20), 5);
});

test('town wins only after all mafia are eliminated', () => {
  assert.equal(winningTeam([{ alive: true, team: 'town' }, { alive: false, team: 'mafia' }]), 'town');
});

test('mafia wins at parity and when outnumbering town', () => {
  assert.equal(winningTeam([{ alive: true, team: 'mafia' }, { alive: true, team: 'town' }]), 'mafia');
  assert.equal(winningTeam([{ alive: true, team: 'mafia' }, { alive: true, team: 'mafia' }, { alive: true, team: 'town' }]), 'mafia');
});

test('winner check ignores eliminated players', () => {
  assert.equal(winningTeam([
    { alive: true, team: 'mafia' },
    { alive: true, team: 'town' },
    { alive: false, team: 'town' },
  ]), 'mafia');
});

test('game continues while town outnumbers mafia', () => {
  assert.equal(winningTeam([
    { alive: true, team: 'mafia' },
    { alive: true, team: 'town' },
    { alive: true, team: 'town' },
  ]), null);
});

test('vote leaders count living voters and allow abstentions', () => {
  assert.deepEqual(voteLeaders({ a: 'x', b: 'x', c: 'y' }, ['a', 'b', 'c', 'x', 'y']), ['x']);
  assert.deepEqual(voteLeaders({ a: 'x' }, ['a', 'b', 'x']), ['x']);
  assert.deepEqual(voteLeaders({}, ['a', 'b']), []);
});

test('vote leaders ignore dead voters, dead targets, and non-candidates in a revote', () => {
  assert.deepEqual(voteLeaders({ dead: 'x', a: 'deadTarget', b: 'outside', c: 'x' }, ['a', 'b', 'c', 'x', 'y'], ['x', 'y']), ['x']);
});

test('equal leading votes return all tied candidates', () => {
  assert.deepEqual(new Set(voteLeaders({ a: 'x', b: 'y' }, ['a', 'b', 'x', 'y'])), new Set(['x', 'y']));
});

test('doctor may protect another living player unless that player was protected last night', () => {
  const doctor = { id: 'd', role: 'doctor', alive: true, lastProtectedId: 'a' };
  assert.equal(doctorCanProtect(doctor, { id: 'b', alive: true }), true);
  assert.equal(doctorCanProtect(doctor, { id: 'a', alive: true }), false);
});

test('doctor cannot protect self, dead players, or act when eliminated', () => {
  const doctor = { id: 'd', role: 'doctor', alive: true };
  assert.equal(doctorCanProtect(doctor, { id: 'd', alive: true }), false);
  assert.equal(doctorCanProtect(doctor, { id: 'b', alive: false }), false);
  assert.equal(doctorCanProtect({ ...doctor, alive: false }, { id: 'b', alive: true }), false);
});

test('team progress awards one point for participation and one more for winning', () => {
  assert.equal(progressGain({ team: 'town', winning: 'town', currentLevel: 0 }), 2);
  assert.equal(progressGain({ team: 'mafia', winning: 'town', currentLevel: 0 }), 1);
});

test('forfeits receive no progress and levels cannot exceed 100', () => {
  assert.equal(progressGain({ team: 'town', winning: 'town', forfeited: true, currentLevel: 10 }), 0);
  assert.equal(progressGain({ team: 'town', winning: 'town', currentLevel: 99 }), 1);
  assert.equal(progressGain({ team: 'mafia', winning: 'town', currentLevel: 100 }), 0);
});

test('night kill roles can be shown to all mafia, voters only, or nobody', () => {
  const players = [
    { id: 'm1', team: 'mafia' }, { id: 'm2', team: 'mafia' }, { id: 'm3', team: 'mafia' },
    { id: 't1', team: 'town' }, { id: 't2', team: 'town' },
  ];
  const votes = { m1: 't1', m2: 't1', m3: 't2' };
  assert.deepEqual(roleRevealViewers({ players, votes, victimId: 't1', cause: 'mafia-kill', visibility: 'team' }), ['m1', 'm2', 'm3']);
  assert.deepEqual(roleRevealViewers({ players, votes, victimId: 't1', cause: 'mafia-kill', visibility: 'killer' }), ['m1', 'm2']);
  assert.deepEqual(roleRevealViewers({ players, votes, victimId: 't1', cause: 'mafia-kill', visibility: 'none' }), []);
});

test('town vote role reveal can show the eliminated role to town teammates only', () => {
  const players = [{ id: 'm1', team: 'mafia' }, { id: 't1', team: 'town' }, { id: 't2', team: 'town' }];
  assert.deepEqual(roleRevealViewers({ players, victimId: 'm1', cause: 'town-vote', visibility: 'team' }), ['t1', 't2']);
  assert.deepEqual(roleRevealViewers({ players, victimId: 'm1', cause: 'town-vote', visibility: 'none' }), []);
});

test('presence is online only while the last heartbeat is inside the timeout window', () => {
  assert.equal(isConnected(1000, 1499, 500), true);
  assert.equal(isConnected(1000, 1500, 500), false);
  assert.equal(isConnected(undefined, 1200, 500), false);
  assert.equal(isConnected(1200, 1100, 500), false);
});
