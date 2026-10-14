'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const dataDirName = `.test-data-${process.pid}-${crypto.randomUUID()}`;
const dataDir = path.join(projectRoot, dataDirName);
let serverProcess;
let baseUrl;

function waitForServer() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); serverProcess.stdout.off('data', onData); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.once('error', (error) => { clearTimeout(timeout); reject(error); });
    serverProcess.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited with ${code}. ${output}`)); });
  });
}

async function api(route, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  return { response, payload };
}

test('8-player HTTP game covers accounts, secret roles, doctor actions, full day, and moderation', async (t) => {
  assert.ok(path.resolve(dataDir).startsWith(projectRoot + path.sep), 'test data must stay inside the project folder');
  fs.mkdirSync(dataDir, { recursive: false });
  const bonusFixtures = Object.fromEntries([
    ['BonusTime', 10, 'discussion_time'], ['BonusVote', 20, 'weighted_vote'], ['BonusShield', 30, 'check_shield'],
  ].map(([username, threshold, effect]) => {
    const id = crypto.randomUUID(); const salt = crypto.randomBytes(16).toString('hex');
    const bonus = { id: `fixture-${effect}`, threshold, team: 'town', key: `town-${threshold}`, effect, grantedAt: Date.now(), usedAt: null };
    return [username, { account: { id, username, salt, passwordHash: crypto.scryptSync('secret-pass', salt, 64).toString('hex'), peacefulLevel: threshold, mafiaLevel: 0, createdAt: Date.now(), bonuses: [bonus] }, bonus }];
  }));
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(Object.fromEntries(Object.values(bonusFixtures).map(({ account }) => [account.id, account]))));
  serverProcess = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot,
    env: { ...process.env, PORT: '0', MAFIA_DATA_DIR: dataDirName, MAFIA_ADMIN_USERNAME: 'ApiAdmin', MAFIA_ADMIN_PASSWORD: 'secret-pass', MAFIA_TEST_SEED_ROLES: '1', MAFIA_NIGHT_MS: '10000', MAFIA_LOBBY_MS: '1000', MAFIA_DISCUSSION_MS: '250', MAFIA_SPEECH_MS: '1000', MAFIA_PRESENCE_TIMEOUT_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
      const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
      serverProcess.kill(); await exited;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== 'EPERM' || attempt === 19) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
  });
  let stderr = '';
  serverProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  baseUrl = await waitForServer();

  const homepage = await api('/');
  assert.equal(homepage.response.status, 200);
  assert.match(homepage.payload, /id="help-open"/);
  assert.match(homepage.payload, /id="help-dialog"/);
  assert.match(homepage.payload, /id="game-admin-open"/);
  const clientScript = await api('/app.js');
  assert.equal(clientScript.response.status, 200);
  assert.match(clientScript.payload, /help-dialog/);
  assert.match(clientScript.payload, /\/api\/team-choice/);
  assert.match(clientScript.payload, /\/api\/bonus\/use/);

  const noSession = await api('/api/me');
  assert.equal(noSession.response.status, 401);
  const emptyPassword = await api('/api/register', { method: 'POST', body: { username: 'EmptyPass', password: '' } });
  assert.equal(emptyPassword.response.status, 400);

  const first = await api('/api/login', { method: 'POST', body: { username: 'ApiAdmin', password: 'secret-pass' } });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.account.isAdmin, true);
  assert.equal(first.payload.account.peacefulLevel, 0);
  assert.equal(first.payload.account.mafiaLevel, 0);
  assert.equal(first.payload.account.hidePeacefulLevel, false);
  assert.equal(first.payload.account.hideMafiaLevel, false);
  assert.equal('passwordHash' in first.payload.account, false);
  const adminToken = first.payload.token;
  const botStyleSettings = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { botPersonalityPool: ['friendly', 'chaotic'] } });
  assert.deepEqual(botStyleSettings.payload.settings.botPersonalityPool, ['friendly', 'chaotic']);

  const testRoom = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  assert.equal(testRoom.response.status, 201);
  assert.equal(testRoom.payload.room.lobbyTimerKind, 'human-fill');
  const disableAutoFill = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: false } });
  assert.equal(disableAutoFill.payload.settings.autoFillBots, false);
  const roomWaitingForPeople = await api(`/api/room/${testRoom.payload.room.code}?player=${encodeURIComponent(testRoom.payload.playerId)}`, { token: adminToken });
  assert.equal(roomWaitingForPeople.payload.deadline, null);
  assert.equal(roomWaitingForPeople.payload.lobbyTimerKind, null);
  const enableAutoFill = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: true, humanWaitSeconds: 60, startDelaySeconds: 30 } });
  assert.equal(enableAutoFill.payload.settings.autoFillBots, true);
  const shortenWait = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { humanWaitSeconds: 1 } });
  assert.equal(shortenWait.payload.settings.humanWaitSeconds, 1);
  const autoFillDeadline = Date.now() + 2500;
  let autoFilledRoom;
  do {
    const current = await api(`/api/room/${testRoom.payload.room.code}?player=${encodeURIComponent(testRoom.payload.playerId)}`, { token: adminToken });
    autoFilledRoom = current.payload;
    if (autoFilledRoom.players.filter((player) => player.bot).length >= 5) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < autoFillDeadline);
  assert.equal(autoFilledRoom.players.length, 6, `automatic bot filling should reach six players: ${JSON.stringify(autoFilledRoom.players)}`);
  assert.equal(autoFilledRoom.lobbyTimerKind, 'start');
  const filledTestRoom = await api('/api/admin/test-fill', { method: 'POST', token: adminToken, body: { code: testRoom.payload.room.code, count: 20 } });
  assert.equal(filledTestRoom.response.status, 200, JSON.stringify(filledTestRoom.payload));
  assert.equal(filledTestRoom.payload.added, 14);
  assert.equal(filledTestRoom.payload.room.players.length, 20);
  assert.equal(filledTestRoom.payload.room.players.filter((player) => player.bot).length, 19);
  assert.ok(filledTestRoom.payload.room.players.filter((player) => player.bot).every((player) => ['friendly', 'chaotic'].includes(player.personality)));
  assert.ok(filledTestRoom.payload.room.deadline, 'filling the room should start its normal lobby countdown');
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: true, humanWaitSeconds: 60, startDelaySeconds: 1, botPersonalityPool: ['friendly', 'jokester', 'sharp', 'chaotic', 'gentle'] } });
  const leaveTestRoom = await api('/api/leave', { method: 'POST', token: adminToken, body: { code: testRoom.payload.room.code, playerId: testRoom.payload.playerId } });
  assert.equal(leaveTestRoom.response.status, 200);

  const extendedAccounts = [];
  for (let index = 0; index < 9; index++) {
    const registration = await api('/api/register', { method: 'POST', body: { username: `Special${index}`, password: 'x' } });
    extendedAccounts.push({ token: registration.payload.token });
  }
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: false, roleRevealTestRooms: true, startDelaySeconds: 30 } });
  const extendedRoomCreate = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  const extendedCode = extendedRoomCreate.payload.room.code;
  const extendedParticipants = [{ token: adminToken, playerId: extendedRoomCreate.payload.playerId }];
  for (const player of extendedAccounts) {
    const joined = await api('/api/join', { method: 'POST', token: player.token, body: { code: extendedCode } });
    assert.equal(joined.response.status, 201, JSON.stringify(joined.payload));
    extendedParticipants.push({ ...player, playerId: joined.payload.playerId });
  }
  const extendedLobby = await api(`/api/room/${extendedCode}?player=${encodeURIComponent(extendedRoomCreate.payload.playerId)}`, { token: adminToken });
  assert.equal(extendedLobby.payload.lobbyTimerKind, 'start');
  const enableSpecialRoles = await api('/api/admin/test-room-settings', { method: 'POST', token: adminToken, body: { code: extendedCode, specialRoles: true, revealEliminatedRoles: true } });
  assert.equal(enableSpecialRoles.response.status, 200, JSON.stringify(enableSpecialRoles.payload));
  assert.equal(enableSpecialRoles.payload.testSpecialRoles, true, JSON.stringify(enableSpecialRoles.payload));
  const settingsRoomState = await api('/api/admin/rooms', { token: adminToken });
  assert.equal(settingsRoomState.payload.rooms.find((entry) => entry.code === extendedCode).testSpecialRoles, true);
  assert.equal(settingsRoomState.payload.rooms.find((entry) => entry.code === extendedCode).players.length, 10);
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { startDelaySeconds: 1 } });
  let extendedRoom;
  const extendedStartDeadline = Date.now() + 2000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    extendedRoom = (await api(`/api/room/${extendedCode}?player=${encodeURIComponent(extendedRoomCreate.payload.playerId)}`, { token: adminToken })).payload;
  } while (extendedRoom.phase === 'lobby' && Date.now() < extendedStartDeadline);
  assert.equal(extendedRoom.phase, 'night');
  const extendedPlayers = extendedRoom.players;
  assert.equal(extendedPlayers.length, 10);
  const extendedRoles = [];
  for (const player of extendedParticipants) {
    const view = await api(`/api/room/${extendedCode}?player=${encodeURIComponent(player.playerId)}`, { token: player.token });
    extendedRoles.push({ ...player, role: view.payload.you.role, team: view.payload.you.team });
  }
  assert.ok(extendedRoles.some((player) => player.role === 'mayor'));
  const don = extendedRoles.find((player) => player.role === 'don');
  const commissioner = extendedRoles.find((player) => player.role === 'detective');
  const donorCheck = await api('/api/action', { method: 'POST', token: don.token, body: { code: extendedCode, playerId: don.playerId, action: 'investigate', targetId: commissioner.playerId } });
  assert.equal(donorCheck.response.status, 200, JSON.stringify(donorCheck.payload));
  assert.equal(donorCheck.payload.night.isMafia, true);
  const townBot = extendedRoles.find((player) => player.team === 'town');
  const privateCheck = await api(`/api/room/${extendedCode}?player=${encodeURIComponent(townBot.playerId)}`, { token: townBot.token });
  assert.equal(privateCheck.payload.night?.isMafia, undefined, 'don investigation result must not leak to town');
  const donorMurderVote = await api('/api/action', { method: 'POST', token: don.token, body: { code: extendedCode, playerId: don.playerId, action: 'mafia', targetId: townBot.playerId } });
  assert.equal(donorMurderVote.response.status, 400);
  await api('/api/leave', { method: 'POST', token: adminToken, body: { code: extendedCode, playerId: extendedRoomCreate.payload.playerId } });
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: true, humanWaitSeconds: 60, startDelaySeconds: 1, roleRevealTestRooms: false } });

  const duplicate = await api('/api/register', { method: 'POST', body: { username: ' apiADMIN ', password: 'secret-pass' } });
  assert.equal(duplicate.response.status, 400);

  const playerTokens = [];
  for (let index = 0; index < 7; index++) {
    const registration = await api('/api/register', { method: 'POST', body: { username: `Player${index}`, password: index === 0 ? 'x' : 'secret-pass' } });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
    assert.equal(registration.payload.account.isAdmin, false);
    playerTokens.push(registration.payload.token);
  }

  const deniedAdmin = await api('/api/admin/rooms', { token: playerTokens[0] });
  assert.equal(deniedAdmin.response.status, 403);
  const deniedSettings = await api('/api/admin/settings', { method: 'POST', token: playerTokens[0], body: { teasingHumor: true } });
  assert.equal(deniedSettings.response.status, 403);
  const initialSettings = await api('/api/admin/rooms', { token: adminToken });
  assert.equal(initialSettings.payload.settings.teasingHumor, false);
  assert.equal(initialSettings.payload.settings.autoFillBots, true);
  assert.equal(initialSettings.payload.settings.humanWaitSeconds, 60);
  assert.equal(initialSettings.payload.settings.startDelaySeconds, 1);
  assert.equal(initialSettings.payload.settings.roleRevealTestRooms, false);
  assert.equal(initialSettings.payload.settings.mafiaKillRoleVisibility, 'none');
  assert.equal(initialSettings.payload.settings.townVoteRoleVisibility, 'none');
  const revealSettings = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { mafiaKillRoleVisibility: 'team', townVoteRoleVisibility: 'team' } });
  assert.equal(revealSettings.payload.settings.mafiaKillRoleVisibility, 'team');
  assert.equal(revealSettings.payload.settings.townVoteRoleVisibility, 'team');
  const invalidRevealSetting = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { mafiaKillRoleVisibility: 'everyone' } });
  assert.equal(invalidRevealSetting.response.status, 400);
  assert.equal(initialSettings.payload.settings.bonusesEnabled, false);
  const enableTestReveal = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { roleRevealTestRooms: true } });
  assert.equal(enableTestReveal.payload.settings.roleRevealTestRooms, true);
  const enabledBonusSettings = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { bonusesEnabled: true, bonusIntervalSeconds: 3600 } });
  assert.equal(enabledBonusSettings.payload.settings.bonusIntervalSeconds, 3600);
  const invalidBonusInterval = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { bonusIntervalSeconds: 10 } });
  assert.equal(invalidBonusInterval.response.status, 400);
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { bonusesEnabled: false, bonusIntervalSeconds: 604800, roleRevealTestRooms: false } });
  assert.deepEqual(initialSettings.payload.settings.botPersonalityPool, ['friendly', 'jokester', 'sharp', 'chaotic', 'gentle']);
  const bonusCheck = await api('/api/me', { token: adminToken });
  assert.deepEqual(bonusCheck.payload.account.bonuses, []);
  assert.equal(bonusCheck.payload.account.nextBonusAt, null);
  const enabledHumor = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { teasingHumor: true } });
  assert.equal(enabledHumor.response.status, 200);
  assert.equal(enabledHumor.payload.settings.teasingHumor, true);
  const invalidSettings = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { teasingHumor: 'yes' } });
  assert.equal(invalidSettings.response.status, 400);
  const invalidBotStyle = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { botPersonalityPool: ['psychic'] } });
  assert.equal(invalidBotStyle.response.status, 400);
  const disableHumor = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { teasingHumor: false } });
  assert.equal(disableHumor.payload.settings.teasingHumor, false);
  const deniedRoomCreate = await api('/api/rooms', { method: 'POST' });
  assert.equal(deniedRoomCreate.response.status, 401);

  const created = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const code = created.payload.room.code;
  const ownerPlayerId = created.payload.playerId;
  const participants = [{ token: adminToken, playerId: ownerPlayerId }];
  for (const token of playerTokens) {
    const joined = await api('/api/join', { method: 'POST', token, body: { code } });
    assert.equal(joined.response.status, 201, JSON.stringify(joined.payload));
    participants.push({ token, playerId: joined.payload.playerId });
  }
  const initialRosterForAdmin = await api(`/api/room/${code}?player=${encodeURIComponent(ownerPlayerId)}`, { token: adminToken });
  assert.ok(initialRosterForAdmin.payload.players.every((player) => typeof player.peacefulLevel === 'number' && typeof player.mafiaLevel === 'number'), 'account levels should be public by default');
  const player0AccountId = (await api('/api/admin/accounts', { token: adminToken })).payload.accounts.find((account) => account.username === 'Player0').id;
  const hiddenLevelTarget = await api('/api/admin/account-visibility', { method: 'POST', token: adminToken, body: { accountId: first.payload.account.id, hidePeacefulLevel: true, hideMafiaLevel: false } });
  assert.equal(hiddenLevelTarget.response.status, 200);
  const hiddenRosterForOther = await api(`/api/room/${code}?player=${encodeURIComponent(participants[1].playerId)}`, { token: participants[1].token });
  const otherPlayerLevels = hiddenRosterForOther.payload.players.find((player) => player.id === ownerPlayerId);
  assert.equal(otherPlayerLevels.peacefulLevel, null);
  assert.equal(otherPlayerLevels.mafiaLevel, 0);
  const player0RoomPlayer = participants.find((participant) => participant.token === playerTokens[0]);
  const hiddenRosterForOwner = await api(`/api/room/${code}?player=${encodeURIComponent(player0RoomPlayer.playerId)}`, { token: player0RoomPlayer.token });
  assert.equal(hiddenRosterForOwner.response.status, 200);
  assert.equal(hiddenRosterForOwner.payload.players.find((player) => player.name === 'Player0').peacefulLevel, 0);
  assert.equal(hiddenRosterForOwner.payload.players.find((player) => player.name === 'Player0').mafiaLevel, 0);
  const adminAfterHide = await api(`/api/room/${code}?player=${encodeURIComponent(ownerPlayerId)}`, { token: adminToken });
  assert.equal(adminAfterHide.payload.players.find((player) => player.id === ownerPlayerId).peacefulLevel, 0);
  const resumed = await api('/api/auto-join', { method: 'POST', token: adminToken, body: {} });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.payload.room.code, code);
  assert.equal(resumed.payload.playerId, ownerPlayerId);
  const enableTestRevealForRoom = await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { roleRevealTestRooms: true } });
  assert.equal(enableTestRevealForRoom.payload.settings.roleRevealTestRooms, true);
  const enableRoomReveal = await api('/api/admin/test-room-settings', { method: 'POST', token: adminToken, body: { code, specialRoles: false, revealEliminatedRoles: true } });
  assert.equal(enableRoomReveal.response.status, 200, JSON.stringify(enableRoomReveal.payload));
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { roleRevealTestRooms: false } });
  const duplicateParticipation = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  assert.equal(duplicateParticipation.response.status, 400);
  assert.match(duplicateParticipation.payload.error, new RegExp(code));

  let room;
  const deadline = Date.now() + 2_000;
  do {
    const current = await api(`/api/room/${code}?player=${encodeURIComponent(ownerPlayerId)}`, { token: adminToken });
    assert.equal(current.response.status, 200);
    room = current.payload;
    if (room.phase !== 'lobby') break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  assert.equal(room.phase, 'night', `expected game to start; server stderr: ${stderr}`);
  assert.equal(room.players.length, 8);
  assert.equal(room.you.role !== undefined, true);
  assert.ok(room.players.filter((player) => player.id !== ownerPlayerId).every((player) => player.role === undefined), 'other players’ roles must remain hidden');
  const hiddenRoomRole = room.players.find((player) => player.id !== ownerPlayerId);
  assert.equal(hiddenRoomRole.role, undefined);
  assert.equal((await api('/api/me', { token: adminToken })).payload.account.bonuses.length, 0);

  const chatAtNight = await api('/api/action', { method: 'POST', token: adminToken, body: { code, playerId: ownerPlayerId, action: 'chat', message: 'secret' } });
  assert.equal(chatAtNight.response.status, 400);
  assert.match(chatAtNight.payload.error, /чат открыт только/i);

  const privateViews = [];
  for (const participant of participants) {
    const view = await api(`/api/room/${code}?player=${encodeURIComponent(participant.playerId)}`, { token: participant.token });
    assert.equal(view.response.status, 200);
    privateViews.push({ ...participant, role: view.payload.you.role, team: view.payload.you.team });
  }
  const mafia = privateViews.find((player) => player.role === 'mafia');
  const mafias = privateViews.filter((player) => player.role === 'mafia');
  const detective = privateViews.find((player) => player.role === 'detective');
  const doctor = privateViews.find((player) => player.role === 'doctor');
  const townies = privateViews.filter((player) => player.team === 'town');
  const villagers = privateViews.filter((player) => player.role === 'villager');
  assert.ok(mafia && detective && doctor && villagers.length >= 2, 'the eight-player setup should contain mafia, commissioner, doctor, and villagers');
  assert.equal(mafias.length, 2);
  const target = villagers.find((player) => player.playerId !== ownerPlayerId);
  const protectTarget = townies.find((player) => player.playerId !== detective.playerId && player.playerId !== doctor.playerId && player.playerId !== target.playerId && player.playerId !== ownerPlayerId);
  assert.ok(protectTarget, 'doctor must have a separate town target');

  const alternateProtectTarget = townies.find((player) => player.playerId !== target.playerId && player.playerId !== protectTarget.playerId && player.playerId !== detective.playerId && player.playerId !== doctor.playerId && player.playerId !== ownerPlayerId);
  assert.ok(alternateProtectTarget);

  const presence = await api(`/api/room/${code}?player=${encodeURIComponent(target.playerId)}`, { token: target.token });
  assert.equal(presence.response.status, 200);
  assert.equal(presence.payload.you.alive, true);
  await new Promise((resolve) => setTimeout(resolve, 125));
  const stalePresence = await api('/api/admin/rooms', { token: adminToken });
  assert.equal(stalePresence.payload.rooms.find((room) => room.code === code).players.find((player) => player.id === target.playerId).connected, false);
  const reconnected = await api(`/api/room/${code}?player=${encodeURIComponent(target.playerId)}`, { token: target.token });
  assert.equal(reconnected.response.status, 200);
  assert.equal(reconnected.payload.players.find((player) => player.id === target.playerId).connected, true);
  const kickedMafia = mafias.find((player) => player.playerId !== ownerPlayerId);
  const survivingMafia = mafias.find((player) => player.playerId !== kickedMafia.playerId);
  assert.ok(kickedMafia && survivingMafia);
  for (const player of mafias) {
    const mafiaAction = await api('/api/action', { method: 'POST', token: player.token, body: { code, playerId: player.playerId, action: 'mafia', targetId: target.playerId } });
    assert.equal(mafiaAction.response.status, 200, JSON.stringify(mafiaAction.payload));
  }
  const doctorSelfTarget = await api('/api/action', { method: 'POST', token: doctor.token, body: { code, playerId: doctor.playerId, action: 'protect', targetId: doctor.playerId } });
  assert.equal(doctorSelfTarget.response.status, 400);
  const doctorAction = await api('/api/action', { method: 'POST', token: doctor.token, body: { code, playerId: doctor.playerId, action: 'protect', targetId: protectTarget.playerId } });
  assert.equal(doctorAction.response.status, 200, JSON.stringify(doctorAction.payload));
  assert.equal(doctorAction.payload.night.protectedId, protectTarget.playerId);
  const changedProtection = await api('/api/action', { method: 'POST', token: doctor.token, body: { code, playerId: doctor.playerId, action: 'protect', targetId: alternateProtectTarget.playerId } });
  assert.equal(changedProtection.response.status, 200, JSON.stringify(changedProtection.payload));
  const restoredProtection = await api('/api/action', { method: 'POST', token: doctor.token, body: { code, playerId: doctor.playerId, action: 'protect', targetId: protectTarget.playerId } });
  assert.equal(restoredProtection.response.status, 200, JSON.stringify(restoredProtection.payload));
  const detectiveAction = await api('/api/action', { method: 'POST', token: detective.token, body: { code, playerId: detective.playerId, action: 'investigate', targetId: protectTarget.playerId } });
  assert.equal(detectiveAction.response.status, 200, JSON.stringify(detectiveAction.payload));
  assert.equal(detectiveAction.payload.phase, 'discussion', `stderr=${stderr}`);
  const checkedRole = privateViews.find((player) => player.playerId === protectTarget.playerId).role;
  assert.deepEqual(detectiveAction.payload.you.investigationHistory.map(({ day, targetId, role }) => ({ day, targetId, role })), [{ day: 1, targetId: protectTarget.playerId, role: checkedRole }]);
  assert.equal(detectiveAction.payload.players.find((player) => player.id === protectTarget.playerId).role, checkedRole, 'the commissioner sees the checked role card');
  const otherPlayer = townies.find((player) => player.playerId !== detective.playerId && player.playerId !== protectTarget.playerId && player.playerId !== target.playerId);
  const otherPrivateView = await api(`/api/room/${code}?player=${encodeURIComponent(otherPlayer.playerId)}`, { token: otherPlayer.token });
  assert.equal(otherPrivateView.payload.you.investigationHistory, undefined, 'investigation notes are private to the commissioner');
  assert.equal(otherPrivateView.payload.players.find((player) => player.id === protectTarget.playerId).role, undefined, 'other players do not see the commissioner check');
  const mafiaView = await api(`/api/room/${code}?player=${encodeURIComponent(mafia.playerId)}`, { token: mafia.token });
  assert.equal(mafiaView.payload.players.find((player) => player.id === target.playerId).role, 'villager', 'the configured whole-mafia reveal shows the dead role card');
  const townView = await api(`/api/room/${code}?player=${encodeURIComponent(otherPlayer.playerId)}`, { token: otherPlayer.token });
  assert.equal(townView.payload.players.find((player) => player.id === target.playerId).role, undefined, 'night-death role remains hidden from town when only mafia reveal is enabled');
  const dayChat = await api('/api/action', { method: 'POST', token: detective.token, body: { code, playerId: detective.playerId, action: 'chat', message: 'API integration message' } });
  assert.equal(dayChat.response.status, 200, JSON.stringify(dayChat.payload));
  assert.equal(dayChat.payload.you.investigationHistory.length, 1, 'the private check remains visible after the night ends');
  assert.equal(dayChat.payload.chat.at(-1).text, 'API integration message');

  let day = dayChat.payload;
  const phaseDeadline = Date.now() + 3_000;
  while (day.phase === 'discussion' && Date.now() < phaseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await api(`/api/room/${code}?player=${encodeURIComponent(ownerPlayerId)}`, { token: adminToken });
    assert.equal(current.response.status, 200);
    day = current.payload;
  }
  assert.equal(day.phase, 'speeches', `discussion should advance to speeches; server stderr: ${stderr}`);
  let checkedOutOfTurn = false;
  while (day.phase === 'speeches') {
    const speaker = participants.find((player) => player.playerId === day.currentSpeaker);
    assert.ok(speaker, `speaker ${day.currentSpeaker} should have an account`);
    if (!checkedOutOfTurn) {
      const other = participants.find((player) => player.playerId !== speaker.playerId && day.players.find((entry) => entry.id === player.playerId)?.alive);
      assert.ok(other);
      const outOfTurn = await api('/api/action', { method: 'POST', token: other.token, body: { code, playerId: other.playerId, action: 'speak' } });
      assert.equal(outOfTurn.response.status, 400);
      checkedOutOfTurn = true;
    }
    const firstSpeech = day.chat.filter((message) => message.speech).length === 0;
    const passed = await api('/api/action', { method: 'POST', token: speaker.token, body: { code, playerId: speaker.playerId, action: firstSpeech ? 'speech' : 'speak', ...(firstSpeech ? { message: 'Моя первая версия событий.' } : {}) } });
    assert.equal(passed.response.status, 200, JSON.stringify(passed.payload));
    assert.equal(passed.payload.players.find((player) => player.id === speaker.playerId).hasSpoken, true);
    if (firstSpeech) assert.equal(passed.payload.chat.at(-1).text, 'Моя первая версия событий.');
    day = passed.payload;
  }
  assert.equal(day.phase, 'voting');

  let alive = day.players.filter((player) => player.alive).map((player) => participants.find((participant) => participant.playerId === player.id));
  assert.equal(alive.length, 7);
  for (const voter of alive) {
    const targetId = voter.playerId === mafia.playerId ? protectTarget.playerId : mafia.playerId;
    const vote = await api('/api/action', { method: 'POST', token: voter.token, body: { code, playerId: voter.playerId, action: 'vote', targetId } });
    assert.equal(vote.response.status, 200, JSON.stringify(vote.payload));
    day = vote.payload;
  }
  assert.equal(day.phase, 'night');
  const townRoleRevealView = await api(`/api/room/${code}?player=${encodeURIComponent(otherPlayer.playerId)}`, { token: otherPlayer.token });
  assert.equal(townRoleRevealView.payload.players.find((player) => player.id === mafia.playerId).role, 'mafia', 'the configured town reveal shows a role after vote elimination');
  const repeatProtection = await api('/api/action', { method: 'POST', token: doctor.token, body: { code, playerId: doctor.playerId, action: 'protect', targetId: protectTarget.playerId } });
  assert.equal(repeatProtection.response.status, 400);
  const secondMafiaAttack = await api('/api/action', { method: 'POST', token: survivingMafia.token, body: { code, playerId: survivingMafia.playerId, action: 'mafia', targetId: protectTarget.playerId } });
  assert.equal(secondMafiaAttack.response.status, 200, JSON.stringify(secondMafiaAttack.payload));
  const nextProtectionTarget = participants.find((player) => player.playerId !== target.playerId && player.playerId !== protectTarget.playerId && player.playerId !== detective.playerId && player.playerId !== doctor.playerId && !mafias.some((mafiaPlayer) => mafiaPlayer.playerId === player.playerId) && player.playerId !== ownerPlayerId);
  assert.ok(nextProtectionTarget);
  const nextNightProtection = await api('/api/action', { method: 'POST', token: doctor.token, body: { code, playerId: doctor.playerId, action: 'protect', targetId: nextProtectionTarget.playerId } });
  assert.equal(nextNightProtection.response.status, 200, JSON.stringify(nextNightProtection.payload));
  const secondCheck = await api('/api/action', { method: 'POST', token: detective.token, body: { code, playerId: detective.playerId, action: 'investigate', targetId: survivingMafia.playerId } });
  assert.equal(secondCheck.response.status, 200, JSON.stringify(secondCheck.payload));
  assert.equal(secondCheck.payload.you.investigationHistory.length, 2, 'the investigation journal survives into following nights');

  let finalDay = secondCheck.payload;
  const finalDiscussionDeadline = Date.now() + 6_000;
  while (finalDay.phase === 'discussion' && Date.now() < finalDiscussionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await api(`/api/room/${code}?player=${encodeURIComponent(ownerPlayerId)}`, { token: adminToken });
    assert.equal(current.response.status, 200);
    finalDay = current.payload;
  }
  assert.equal(finalDay.phase, 'speeches', `stderr=${stderr}; log=${JSON.stringify(finalDay.log)}`);
  while (finalDay.phase === 'speeches') {
    const speaker = participants.find((player) => player.playerId === finalDay.currentSpeaker);
    assert.ok(speaker);
    const passed = await api('/api/action', { method: 'POST', token: speaker.token, body: { code, playerId: speaker.playerId, action: 'speak' } });
    assert.equal(passed.response.status, 200, JSON.stringify(passed.payload));
    finalDay = passed.payload;
  }
  assert.equal(finalDay.phase, 'voting');
  const finalAlive = finalDay.players.filter((player) => player.alive);
  assert.equal(finalAlive.length, 5);
  for (const voter of finalAlive) {
    const voterAccount = participants.find((player) => player.playerId === voter.id);
    const chosenTarget = voter.id === survivingMafia.playerId ? finalAlive.find((player) => player.id !== voter.id).id : survivingMafia.playerId;
    const finalVote = await api('/api/action', { method: 'POST', token: voterAccount.token, body: { code, playerId: voter.id, action: 'vote', targetId: chosenTarget } });
    assert.equal(finalVote.response.status, 200, JSON.stringify(finalVote.payload));
    finalDay = finalVote.payload;
  }
  assert.equal(finalDay.phase, 'ended');
  assert.match(finalDay.winner, /город победил/i);
  assert.ok(finalDay.log.some((entry) => entry.text.startsWith(finalDay.winner) && entry.text.length > finalDay.winner.length), 'the narrator should append a dedicated final line after the result');

  const moderationRoom = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  assert.equal(moderationRoom.response.status, 201, JSON.stringify(moderationRoom.payload));
  const moderationCode = moderationRoom.payload.room.code;
  const moderationPlayers = [];
  for (const player of participants.slice(1, 6)) {
    const joined = await api('/api/join', { method: 'POST', token: player.token, body: { code: moderationCode } });
    assert.equal(joined.response.status, 201, JSON.stringify(joined.payload));
    moderationPlayers.push({ ...player, roomPlayerId: joined.payload.playerId });
  }
  const kickCandidate = moderationPlayers[3];
  const moderationKick = await api('/api/admin/moderate', { method: 'POST', token: adminToken, body: { code: moderationCode, playerId: kickCandidate.roomPlayerId, action: 'kick', reason: '' } });
  assert.equal(moderationKick.response.status, 200, JSON.stringify(moderationKick.payload));
  const kickedCannotReconnect = await api(`/api/room/${moderationCode}?player=${encodeURIComponent(kickCandidate.roomPlayerId)}`, { token: kickCandidate.token });
  assert.equal(kickedCannotReconnect.response.status, 403);

  const banCandidate = moderationPlayers[4];
  const adminAccounts = await api('/api/admin/accounts', { token: adminToken });
  const banCandidateUsername = `Player${participants.indexOf(participants.find((player) => player.token === banCandidate.token)) - 1}`;
  const banCandidateAccount = adminAccounts.payload.accounts.find((account) => account.username === banCandidateUsername);
  assert.ok(banCandidateAccount);
  const moderationBan = await api('/api/admin/moderate', { method: 'POST', token: adminToken, body: { code: moderationCode, playerId: banCandidate.roomPlayerId, action: 'ban', reason: 'integration test' } });
  assert.equal(moderationBan.response.status, 200, JSON.stringify(moderationBan.payload));
  assert.equal((await api('/api/me', { token: banCandidate.token })).response.status, 401);
  const unbanCandidate = await api('/api/admin/unban', { method: 'POST', token: adminToken, body: { accountId: banCandidateAccount.id } });
  assert.equal(unbanCandidate.response.status, 200);
  const banCandidateLogin = await api('/api/login', { method: 'POST', body: { username: banCandidateUsername, password: 'secret-pass' } });
  assert.equal(banCandidateLogin.response.status, 200);

  await api('/api/leave', { method: 'POST', token: adminToken, body: { code: moderationCode, playerId: moderationRoom.payload.playerId } });
  const bonusLogins = {};
  for (const username of Object.keys(bonusFixtures)) {
    const login = await api('/api/login', { method: 'POST', body: { username, password: 'secret-pass' } });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload)); bonusLogins[username] = login.payload;
  }
  const bonusFillers = [];
  for (let index = 0; index < 4; index++) bonusFillers.push((await api('/api/register', { method: 'POST', body: { username: `BonusFill${index}`, password: 'x' } })).payload);
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: false, startDelaySeconds: 0 } });

  const discussionRoomCreate = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  const discussionCode = discussionRoomCreate.payload.room.code;
  for (const filler of bonusFillers) filler.roomPlayerId = (await api('/api/join', { method: 'POST', token: filler.token, body: { code: discussionCode } })).payload.playerId;
  const discussionPlayer = await api('/api/join', { method: 'POST', token: bonusLogins.BonusTime.token, body: { code: discussionCode } });
  let discussionState;
  const discussionStartDeadline = Date.now() + 2000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    discussionState = (await api(`/api/room/${discussionCode}?player=${encodeURIComponent(discussionRoomCreate.payload.playerId)}`, { token: adminToken })).payload;
  } while (discussionState.phase === 'lobby' && Date.now() < discussionStartDeadline);
  assert.equal(discussionState.phase, 'night');
  const mafiaTarget = await api('/api/action', { method: 'POST', token: bonusLogins.BonusTime.token, body: { code: discussionCode, playerId: discussionPlayer.payload.playerId, action: 'mafia', targetId: discussionRoomCreate.payload.playerId } });
  assert.equal(mafiaTarget.response.status, 200);
  const nightAction = await api('/api/action', { method: 'POST', token: adminToken, body: { code: discussionCode, playerId: discussionRoomCreate.payload.playerId, action: 'investigate', targetId: discussionPlayer.payload.playerId } });
  assert.equal(nightAction.payload.phase, 'discussion');
  const beforeExtraTime = (await api(`/api/room/${discussionCode}?player=${encodeURIComponent(discussionPlayer.payload.playerId)}`, { token: bonusLogins.BonusTime.token })).payload.deadline;
  const usedTimeBonus = await api('/api/bonus/use', { method: 'POST', token: bonusLogins.BonusTime.token, body: { code: discussionCode, playerId: discussionPlayer.payload.playerId, bonusId: bonusFixtures.BonusTime.bonus.id } });
  assert.equal(usedTimeBonus.response.status, 200, JSON.stringify(usedTimeBonus.payload));
  assert.equal(usedTimeBonus.payload.deadline - beforeExtraTime, 30_000);
  assert.equal(usedTimeBonus.payload.accountBonuses.length, 0);
  await api('/api/leave', { method: 'POST', token: adminToken, body: { code: discussionCode, playerId: discussionRoomCreate.payload.playerId } });
  await api('/api/leave', { method: 'POST', token: bonusLogins.BonusTime.token, body: { code: discussionCode, playerId: discussionPlayer.payload.playerId } });
  for (const filler of bonusFillers) await api('/api/leave', { method: 'POST', token: filler.token, body: { code: discussionCode, playerId: filler.roomPlayerId } });

  const voteRoomCreate = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  const voteCode = voteRoomCreate.payload.room.code;
  for (const filler of bonusFillers) filler.roomPlayerId = (await api('/api/join', { method: 'POST', token: filler.token, body: { code: voteCode } })).payload.playerId;
  const votePlayer = await api('/api/join', { method: 'POST', token: bonusLogins.BonusVote.token, body: { code: voteCode } });
  let voteState;
  const voteGameDeadline = Date.now() + 5000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    voteState = (await api(`/api/room/${voteCode}?player=${encodeURIComponent(voteRoomCreate.payload.playerId)}`, { token: adminToken })).payload;
    if (voteState.phase === 'night') break;
  } while (Date.now() < voteGameDeadline);
  const voteNightAttack = await api('/api/action', { method: 'POST', token: bonusLogins.BonusVote.token, body: { code: voteCode, playerId: votePlayer.payload.playerId, action: 'mafia', targetId: voteRoomCreate.payload.playerId } });
  assert.equal(voteNightAttack.response.status, 200);
  const wakeUp = await api('/api/action', { method: 'POST', token: adminToken, body: { code: voteCode, playerId: voteRoomCreate.payload.playerId, action: 'investigate', targetId: votePlayer.payload.playerId } });
  assert.equal(wakeUp.response.status, 200);
  const speechDeadline = Date.now() + 15_000;
  let votePlayerId = votePlayer.payload.playerId;
  while (wakeUp.payload.phase !== 'voting' && Date.now() < speechDeadline) {
    const current = (await api(`/api/room/${voteCode}?player=${encodeURIComponent(voteRoomCreate.payload.playerId)}`, { token: adminToken })).payload;
    const turnAccounts = [{ token: adminToken, playerId: voteRoomCreate.payload.playerId }, ...bonusFillers.map((filler) => ({ token: filler.token, playerId: filler.roomPlayerId })), { token: bonusLogins.BonusVote.token, playerId: votePlayerId }];
    const speaker = turnAccounts.find((entry) => entry.playerId === current.currentSpeaker);
    if (current.phase === 'speeches' && speaker) {
      await api('/api/action', { method: 'POST', token: speaker.token, body: { code: voteCode, playerId: speaker.playerId, action: 'speak' } });
    }
    if (current.phase === 'voting') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  let activeVote = (await api(`/api/room/${voteCode}?player=${encodeURIComponent(votePlayerId)}`, { token: bonusLogins.BonusVote.token })).payload;
  const votingDeadline = Date.now() + 5000;
  while (activeVote.phase !== 'voting' && Date.now() < votingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    activeVote = (await api(`/api/room/${voteCode}?player=${encodeURIComponent(votePlayerId)}`, { token: bonusLogins.BonusVote.token })).payload;
  }
  assert.equal(activeVote.phase, 'voting');
  const usedVoteBonus = await api('/api/bonus/use', { method: 'POST', token: bonusLogins.BonusVote.token, body: { code: voteCode, playerId: votePlayerId, bonusId: bonusFixtures.BonusVote.bonus.id } });
  assert.equal(usedVoteBonus.response.status, 200, JSON.stringify(usedVoteBonus.payload));
  const voteTarget = activeVote.players.find((player) => player.id !== votePlayerId && player.alive);
  const weightedVote = await api('/api/action', { method: 'POST', token: bonusLogins.BonusVote.token, body: { code: voteCode, playerId: votePlayerId, action: 'vote', targetId: voteTarget.id } });
  assert.equal(weightedVote.response.status, 200, JSON.stringify(weightedVote.payload));
  assert.equal(weightedVote.payload.votes.find((vote) => vote.voterId === votePlayerId).weight, 2);
  await api('/api/leave', { method: 'POST', token: adminToken, body: { code: voteCode, playerId: voteRoomCreate.payload.playerId } });
  await api('/api/leave', { method: 'POST', token: bonusLogins.BonusVote.token, body: { code: voteCode, playerId: votePlayerId } });
  for (const filler of bonusFillers) await api('/api/leave', { method: 'POST', token: filler.token, body: { code: voteCode, playerId: filler.roomPlayerId } });

  const shieldRoomCreate = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  const shieldCode = shieldRoomCreate.payload.room.code;
  for (const filler of bonusFillers) filler.roomPlayerId = (await api('/api/join', { method: 'POST', token: filler.token, body: { code: shieldCode } })).payload.playerId;
  const shieldPlayer = await api('/api/join', { method: 'POST', token: bonusLogins.BonusShield.token, body: { code: shieldCode } });
  let shieldState = (await api(`/api/room/${shieldCode}?player=${encodeURIComponent(shieldRoomCreate.payload.playerId)}`, { token: adminToken })).payload;
  assert.equal(shieldState.phase, 'night');
  const shieldedMafia = await api('/api/bonus/use', { method: 'POST', token: bonusLogins.BonusShield.token, body: { code: shieldCode, playerId: shieldPlayer.payload.playerId, bonusId: bonusFixtures.BonusShield.bonus.id } });
  assert.equal(shieldedMafia.response.status, 200, JSON.stringify(shieldedMafia.payload));
  const mafiaNightVote = await api('/api/action', { method: 'POST', token: bonusLogins.BonusShield.token, body: { code: shieldCode, playerId: shieldPlayer.payload.playerId, action: 'mafia', targetId: shieldRoomCreate.payload.playerId } });
  assert.equal(mafiaNightVote.response.status, 200);
  const maskedInvestigation = await api('/api/action', { method: 'POST', token: adminToken, body: { code: shieldCode, playerId: shieldRoomCreate.payload.playerId, action: 'investigate', targetId: shieldPlayer.payload.playerId } });
  assert.equal(maskedInvestigation.response.status, 200, JSON.stringify(maskedInvestigation.payload));
  assert.equal(maskedInvestigation.payload.night.isMafia, null, 'night shield must not return a misleading town result');
  assert.equal(maskedInvestigation.payload.night.targetRole, null, 'night shield conceals the role from the commissioner');
  assert.equal(maskedInvestigation.payload.night.blocked, true);
  await api('/api/leave', { method: 'POST', token: adminToken, body: { code: shieldCode, playerId: shieldRoomCreate.payload.playerId } });
  await api('/api/leave', { method: 'POST', token: bonusLogins.BonusShield.token, body: { code: shieldCode, playerId: shieldPlayer.payload.playerId } });
  for (const filler of bonusFillers) await api('/api/leave', { method: 'POST', token: filler.token, body: { code: shieldCode, playerId: filler.roomPlayerId } });

  const managedRegistration = await api('/api/register', { method: 'POST', body: { username: 'ManagedTest', password: 'old-pass' } });
  assert.equal(managedRegistration.response.status, 201);
  const managedAccount = managedRegistration.payload.account;
  const deniedSelfDelete = await api('/api/admin/delete-account', { method: 'POST', token: adminToken, body: { accountId: first.payload.account.id } });
  assert.equal(deniedSelfDelete.response.status, 400);
  const invalidLevels = await api('/api/admin/account-levels', { method: 'POST', token: adminToken, body: { accountId: managedAccount.id, peacefulLevel: 101, mafiaLevel: 0 } });
  assert.equal(invalidLevels.response.status, 400);
  const changedLevels = await api('/api/admin/account-levels', { method: 'POST', token: adminToken, body: { accountId: managedAccount.id, peacefulLevel: 42, mafiaLevel: 17 } });
  assert.equal(changedLevels.response.status, 200);
  assert.equal(changedLevels.payload.account.peacefulLevel, 42);
  assert.equal(changedLevels.payload.account.mafiaLevel, 17);
  const resetManagedPassword = await api('/api/admin/reset-password', { method: 'POST', token: adminToken, body: { accountId: managedAccount.id } });
  assert.equal(resetManagedPassword.response.status, 200);
  assert.equal((await api('/api/me', { token: managedRegistration.payload.token })).response.status, 401);
  const loginWithResetPassword = await api('/api/login', { method: 'POST', body: { username: 'ManagedTest', password: resetManagedPassword.payload.temporaryPassword } });
  assert.equal(loginWithResetPassword.response.status, 200);
  const deletedManagedAccount = await api('/api/admin/delete-account', { method: 'POST', token: adminToken, body: { accountId: managedAccount.id } });
  assert.equal(deletedManagedAccount.response.status, 200);
  assert.equal((await api('/api/me', { token: loginWithResetPassword.payload.token })).response.status, 401);
  assert.equal((await api('/api/admin/accounts', { token: adminToken })).payload.accounts.some((account) => account.id === managedAccount.id), false);

  for (const participant of participants) {
    const account = await api('/api/me', { token: participant.token === banCandidate.token ? banCandidateLogin.payload.token : participant.token });
    assert.equal(account.response.status, 200);
    const player = privateViews.find((entry) => entry.playerId === participant.playerId);
    assert.equal(account.payload.account[player.team === 'mafia' ? 'mafiaLevel' : 'peacefulLevel'], player.team === 'mafia' ? 1 : 2, `${account.payload.account.username} ${player.role}: ${JSON.stringify(account.payload.account)}`);
  }

  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { autoFillBots: false, startDelaySeconds: 60 } });
  const teamChooser = (await api('/api/register', { method: 'POST', body: { username: 'LevelChooser', password: 'x' } })).payload;
  const setTeamChooserLevels = await api('/api/admin/account-levels', { method: 'POST', token: adminToken, body: { accountId: teamChooser.account.id, peacefulLevel: 100, mafiaLevel: 100 } });
  assert.equal(setTeamChooserLevels.response.status, 200);
  const levelRoom = await api('/api/rooms', { method: 'POST', token: adminToken, body: {} });
  const levelRoomCode = levelRoom.payload.room.code;
  const levelPlayer = await api('/api/join', { method: 'POST', token: teamChooser.token, body: { code: levelRoomCode } });
  const levelFill = await api('/api/admin/test-fill', { method: 'POST', token: adminToken, body: { code: levelRoomCode, count: 20 } });
  assert.equal(levelFill.response.status, 200);
  const teamOptions = await api(`/api/room/${levelRoomCode}?player=${encodeURIComponent(levelPlayer.payload.playerId)}`, { token: teamChooser.token });
  assert.deepEqual(new Set(teamOptions.payload.you.teamChoiceAvailable), new Set(['town', 'mafia']));
  const levelTeamChoice = await api('/api/team-choice', { method: 'POST', token: teamChooser.token, body: { code: levelRoomCode, playerId: levelPlayer.payload.playerId, team: 'mafia' } });
  assert.equal(levelTeamChoice.response.status, 200, JSON.stringify(levelTeamChoice.payload));
  assert.equal(levelTeamChoice.payload.you.teamChoice, 'mafia');
  await api('/api/admin/settings', { method: 'POST', token: adminToken, body: { startDelaySeconds: 1 } });
  let levelRoomStarted;
  const levelStartDeadline = Date.now() + 2500;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    levelRoomStarted = (await api(`/api/room/${levelRoomCode}?player=${encodeURIComponent(levelPlayer.payload.playerId)}`, { token: teamChooser.token })).payload;
  } while (levelRoomStarted.phase === 'lobby' && Date.now() < levelStartDeadline);
  assert.equal(levelRoomStarted.you.team, 'mafia');
  assert.equal(levelRoomStarted.mafia.length, 5, 'level-100 choice keeps the mafia quota at 5 of 20');
  await api('/api/leave', { method: 'POST', token: teamChooser.token, body: { code: levelRoomCode, playerId: levelPlayer.payload.playerId } });
  await api('/api/leave', { method: 'POST', token: adminToken, body: { code: levelRoomCode, playerId: levelRoom.payload.playerId } });

  const otherValidToken = playerTokens[0];
  const wrongOwner = await api(`/api/room/${code}?player=${encodeURIComponent(ownerPlayerId)}`, { token: otherValidToken });
  assert.equal(wrongOwner.response.status, 403);

  const adminRooms = await api('/api/admin/rooms', { token: adminToken });
  assert.equal(adminRooms.response.status, 200);
  assert.equal(adminRooms.payload.rooms.find((entry) => entry.code === code).players.length, 8);

  const loggedOut = await api('/api/logout', { method: 'POST', token: otherValidToken, body: {} });
  assert.equal(loggedOut.response.status, 200);
  const expiredSession = await api('/api/me', { token: otherValidToken });
  assert.equal(expiredSession.response.status, 401);

});
