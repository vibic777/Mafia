'use strict';

const crypto = require('node:crypto');

function randomItem(items) { return items.length ? items[crypto.randomInt(items.length)] : null; }
const BOT_LINES = {
  neutral: ['Давайте сравним версии и решим, кому верим.', 'Я пока собираю факты. Кто хочет высказаться следующим?', 'Мне нужно ещё немного времени, чтобы понять расклад.', 'Пока наблюдаю за обсуждением. Есть что добавить?', 'Предлагаю не торопиться и выслушать всех.'],
  friendly: ['Давайте без спешки разберёмся, у нас есть время.', 'Я могу ошибаться, но давайте сверим версии спокойно.', 'Спасибо, что объяснили. Теперь картина немного яснее.', 'Предлагаю сначала выслушать всех, а потом решать.', 'Мне кажется, {name} рассуждает последовательно. Пока просто наблюдаю.'],
  jokester: ['Моя версия готова. Осталось убедить в ней даже меня самого.', 'Проверил подозрения: обновлений пока нет.', 'Давайте искать мафию. Она, говорят, не отмечается в календаре.', 'Если бы за догадки давали печенье, я бы уже попросил добавку.', 'У {name} такая версия, что таймер попросил продолжение.'],
  sharp: ['{name}, ответь прямо: что думаешь о голосах прошлой ночи?', 'Мне не нравится, как быстро сменились версии. Нужны объяснения.', 'Слишком много уверенности и пока маловато фактов. Продолжайте.', 'Я голосую за ясность: кто кажется подозрительным и почему?', 'Пока наблюдаю за {name}. Хочу услышать конкретную версию.'],
  chaotic: ['Я пересчитал стулья: их всё ещё ноль, а подозрений уже семь.', 'Есть версия, что таймер знает больше нас. Проверить не удалось.', 'Сейчас всё складывается в узор. Правда, я забыл какой именно.', 'Предлагаю подозревать расписание: оно слишком точно знает, что будет дальше.', 'Всё очень логично. Особенно та часть, которую я ещё не придумал.'],
  gentle: ['Это только предположение, но {name} сегодня показался мне немного подозрительным.', 'Не хочу никого торопить. Может, ещё раз спокойно сравним версии?', 'Я прислушиваюсь ко всем. Пока склоняюсь к версии {name}.', 'Мне сложно обвинять без уверенности, но кое-что стоит уточнить.', 'Давайте дадим {name} возможность объяснить эту деталь.']
};
const BOT_REPLIES = {
  neutral: ['Понял мысль, {name}. Кто ещё как это видит?', 'Интересно, {name}. Есть ещё наблюдения в ту же сторону?', 'Давайте проверим эту версию, {name}.', 'Спасибо, {name}. Я запомнил эту деталь.'],
  friendly: ['Понимаю тебя, {name}. Давайте вместе проверим эту мысль.', 'Спасибо за версию, {name}. Кто ещё хочет добавить?', 'Согласен, {name}, это стоит спокойно обсудить.', 'Хорошее замечание, {name}.'],
  jokester: ['Версия {name} вышла на сцену. Принимаем вопросы из зала!', 'Записал, {name}. Мой блокнот попросил автограф.', 'Интересная мысль, {name}. Таймер уже ждёт второй серии.', 'Поддержу обсуждение, {name}. Где тут очередь за попкорном?'],
  sharp: ['{name}, конкретнее: какой факт подтверждает эту версию?', 'Услышал, {name}. Теперь проверим это на фактах.', 'Это пока только слова, {name}. Кто может подтвердить?', 'Хорошо, {name}. А какая версия у тебя самого?'],
  chaotic: ['Принято, {name}. Это подтверждает мою теорию о подозрительном таймере.', 'А если эта мысль — ключ к загадке внутри загадки, {name}? Ладно, продолжай.', 'Записал, {name}. Моя схема на стене стала ещё интереснее.', 'Согласен наполовину, {name}. Вторую половину ещё не придумал.'],
  gentle: ['Спасибо, что поделился, {name}. Давайте выслушаем и остальных.', 'Я услышал тебя, {name}. Возможно, стоит задать ещё один вопрос.', 'Хорошо подмечено, {name}. Я пока понаблюдаю.', 'Давайте без спешки проверим мысль {name}.']
};
const BOT_ROLE_LINES = {
  town: ['Пока это только версия: {name} слишком быстро поддержал первое обвинение.', 'Я бы проверил {name}: сначала он сомневался, а потом резко сменил голос.', 'Есть ощущение, что {name} уводит разговор от вчерашнего голосования.', 'Может, {name} комиссар и проверил кого-то? Это предположение, не доказательство.', 'Если бы я был доктором, я бы сегодня особенно внимательно присмотрелся к {name}. Просто мысль.', 'Предлагаю сравнить слова {name} с тем, как он голосовал вчера.', 'Не уверен, но {name} пока больше всех выигрывает от нашей путаницы.', 'Мафия может сидеть тихо. {name}, расскажи, кого подозреваешь ты?'],
  mafia: ['Мне кажется, {name} слишком уверенно направляет город. Давайте проверим эту версию.', 'Я бы присмотрелся к {name}: он уже второй раз меняет подозреваемого.', 'Поддержу сомнения насчёт {name}. Его версия пока не сходится с голосами.', 'Не торопитесь обвинять {name}; сначала пусть объяснит вчерашний голос.', 'Кажется, {name} пытается выглядеть слишком полезным. Это ещё ничего не доказывает.', 'Среди нас может быть комиссар, но гадать по одному жесту — плохой план.', 'Я бы сегодня обсуждал {name}, а ночью посмотрим, куда приведут версии.', 'Давайте не распыляться: у {name} есть несостыковка, пусть ответит.'],
  detective: ['Я проверил одну версию ночью, но пока не хочу раскрывать все карты. Смотрите на {name}.', 'Некоторые факты я могу подтвердить, но сначала послушаю, что скажет {name}.', 'У меня есть ночная информация. Пока безопаснее сказать: версия против {name} выглядит слабой.', 'Я бы не спешил с голосом против {name}; у меня есть причина сомневаться.'],
  doctor: ['Сегодня ночью я постарался прикрыть город. Давайте днём внимательнее разберём версию {name}.', 'Не буду раскрывать все действия, но потеря {name} была бы плохой новостью для города.', 'Если ночью кто-то избежал беды, это не делает его автоматически мафией. Подумайте о {name}.', 'Я бы сохранил спокойствие и не раскрывал роли без нужды. Что думаешь о голосах, {name}?']
};

function botLine(room, bot) {
  const mentioned = botSuspect(room, bot)?.name || 'сосед';
  if (room.day > 0) {
    const category = bot.team === 'mafia' ? 'mafia' : bot.role === 'detective' ? 'detective' : bot.role === 'doctor' ? 'doctor' : 'town';
    const roleLine = randomItem(BOT_ROLE_LINES[category]).replaceAll('{name}', mentioned);
    const personality = BOT_LINES[bot.personality] ? bot.personality : 'neutral';
    const flavor = { neutral: '', friendly: ' Давайте разберёмся спокойно.', jokester: ' Даже таймер уже ждёт развязку.', sharp: ' Нужны конкретные доводы.', chaotic: ' Моя схема на салфетке это почти подтверждает.', gentle: ' Но это пока только осторожная версия.' }[personality];
    return roleLine + flavor;
  }
  const personality = BOT_LINES[bot.personality] ? bot.personality : 'neutral';
  return randomItem(BOT_LINES[personality]).replaceAll('{name}', mentioned);
}

function botSuspect(room, bot, candidates = null) {
  const available = room.players.filter((player) => player.alive && player.id !== bot.id && (!candidates || candidates.includes(player.id)) && !(bot.team === 'mafia' && player.team === 'mafia'));
  if (!available.length) return null;
  const scores = new Map(available.map((player) => [player.id, 0]));
  for (const message of (room.chat || []).slice(-80)) {
    const text = String(message.text || '').toLocaleLowerCase('ru-RU');
    const accusation = /мафи|подозр|не верю|обвин|голосую за|против/i.test(text);
    const defense = /защит|не маф|довер|не трогай/i.test(text);
    if (!accusation && !defense) continue;
    for (const player of available) {
      if (text.includes(player.name.toLocaleLowerCase('ru-RU'))) scores.set(player.id, scores.get(player.id) + (accusation ? 2 : -1));
    }
    const speaker = available.find((player) => player.id === message.playerId);
    if (speaker && accusation) scores.set(speaker.id, scores.get(speaker.id) + 0.25);
  }
  const check = room.night?.checks?.[bot.id];
  if (bot.role === 'detective' && check) {
    const checkedPlayer = available.find((player) => player.id === check.targetId);
    if (checkedPlayer) scores.set(checkedPlayer.id, scores.get(checkedPlayer.id) + (check.isMafia ? 100 : -100));
  }
  const bestScore = Math.max(...scores.values());
  return randomItem(available.filter((player) => scores.get(player.id) === bestScore));
}

function botTarget(room, bot, candidates = null, { hidden = false } = {}) {
  const available = room.players.filter((player) => player.alive && player.id !== bot.id && (!candidates || candidates.includes(player.id)));
  if (!available.length) return null;
  if (hidden) return randomItem(available.filter((player) => player.team !== 'mafia')) || randomItem(available);
  const confirmedCheck = room.night?.checks?.[bot.id];
  if (bot.role === 'detective' && confirmedCheck?.isMafia) {
    const confirmedMafia = available.find((player) => player.id === confirmedCheck.targetId);
    if (confirmedMafia) return confirmedMafia;
  }
  const strategic = botSuspect(room, bot, candidates);
  if (strategic && Math.random() < 0.8) return strategic;
  const weights = available.map((player) => {
    let weight = bot.team === 'mafia' && player.team === 'mafia' ? 0 : 1;
    const detectiveCheck = room.night?.checks?.[bot.id];
    if (bot.role === 'detective' && detectiveCheck?.targetId === player.id) weight += detectiveCheck.isMafia ? 20 : -0.9;
    return Math.max(0.1, weight);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let index = 0; index < available.length; index++) { roll -= weights[index]; if (roll <= 0) return available[index]; }
  return available.at(-1);
}

function botReplyDelay(room) {
  const latest = [...(room.chat || [])].reverse().find((message) => message.playerId !== 'narrator');
  return latest && latest.bot ? 3_000 + crypto.randomInt(4_001) : 1_200 + crypto.randomInt(2_301);
}

module.exports = { botLine, botTarget, botSuspect, botReplyDelay, BOT_ROLE_LINES };
