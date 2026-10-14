'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { botLine, botTarget, botSuspect, botReplyDelay } = require('../bot-dialogue');

test('bot dialogue depends on role and references plausible roles or suspicions', () => {
  const target = { id: 'target', name: 'Иван', alive: true, team: 'mafia' };
  const other = { id: 'other', name: 'Оля', alive: true, team: 'town' };
  const bots = [
    { id: 'town', name: 'Бот город', bot: true, role: 'villager', team: 'town', alive: true, personality: 'friendly' },
    { id: 'mafia', name: 'Бот мафия', bot: true, role: 'mafia', team: 'mafia', alive: true, personality: 'sharp' },
    { id: 'detective', name: 'Бот комиссар', bot: true, role: 'detective', team: 'town', alive: true, personality: 'gentle' },
    { id: 'doctor', name: 'Бот доктор', bot: true, role: 'doctor', team: 'town', alive: true, personality: 'neutral' },
  ];
  const room = { day: 2, phase: 'discussion', players: [...bots, target, other], chat: [{ playerId: 'other', name: 'Оля', text: 'Я подозреваю Иван, он резко сменил версию.', bot: false }], night: { checks: { detective: { targetId: 'target', isMafia: true } } } };
  assert.match(botLine(room, bots[0]), /Иван|Оля|комиссар|доктор|верс|подозр|мафи|факт|ноч/i, 'town bot should have a game-relevant theory');
  assert.match(botLine(room, bots[1]), /Иван|Оля|комиссар|доктор|верс|подозр|мафи|факт|ноч/i, 'mafia bot should have a game-relevant theory');
  assert.match(botLine(room, bots[2]), /Иван|Оля|комиссар|доктор|верс|подозр|мафи|факт|ноч/i, 'commissioner bot should have a game-relevant theory');
  assert.match(botLine(room, bots[3]), /Иван|Оля|комиссар|доктор|верс|подозр|мафи|факт|ноч/i, 'doctor bot should have a game-relevant theory');
  assert.equal(botSuspect(room, bots[0]).id, 'target', 'bots should understand the named suspect instead of treating the accuser as the target');
  assert.equal(botSuspect(room, bots[1]).id, 'other', 'mafia should not target an allied mafia player');
  assert.equal(botTarget(room, bots[2]).id, 'target', 'commissioner should prioritize their confirmed mafia result');
  assert.notEqual(botTarget(room, bots[0], null, { hidden: true }).team, 'mafia', 'hidden team action should select only non-mafia targets');
});

test('free-chat bots join quickly and react faster after a human message', () => {
  assert.ok(botReplyDelay({ chat: [{ playerId: 'narrator', bot: true }] }) < 3_501, 'first reply should arrive within about 3.5 seconds');
  assert.ok(botReplyDelay({ chat: [{ playerId: 'human', bot: false }] }) < 3_501, 'a human message should get a quick reply');
  assert.ok(botReplyDelay({ chat: [{ playerId: 'bot', bot: true }] }) >= 3_000, 'bots should leave a little room between their own messages');
});
