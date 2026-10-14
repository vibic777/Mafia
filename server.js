const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { smtpSend } = require('./smtp');
const { openStore } = require('./storage');
const { roleSlots, winningTeam: resolveWinningTeam, voteLeaders, doctorCanProtect, progressGain, isConnected, roleRevealViewers } = require('./mafia-rules');
const { botLine, botTarget, botReplyDelay } = require('./bot-dialogue');
const randomItem = (items) => items.length ? items[crypto.randomInt(items.length)] : null;
const BONUS_EFFECTS = {
  discussion_time: { name: 'Дополнительное время', description: 'Продлите свободное обсуждение на 30 секунд.', action: 'bonus-discussion' },
  weighted_vote: { name: 'Решающий голос', description: 'Ваш голос в текущем голосовании будет весить два.', action: 'bonus-vote' },
  check_shield: { name: 'Защита от проверки', description: 'Этой ночью комиссар не сможет определить вашу команду.', action: 'bonus-shield' },
};
function bonusEffect(threshold) { return ['discussion_time', 'weighted_vote', 'check_shield'][((threshold / 10) - 1) % 3]; }

const ROOT = __dirname;
const requestedDataDir = process.env.MAFIA_DATA_DIR;
const DATA_DIR = requestedDataDir ? path.resolve(ROOT, requestedDataDir) : path.join(ROOT, 'data');
if (DATA_DIR !== ROOT && !DATA_DIR.startsWith(ROOT + path.sep)) throw new Error('Папка данных должна находиться внутри папки проекта');
const store = openStore(DATA_DIR);
const PID_FILE = process.env.MAFIA_MANAGED_SERVER === '1' ? path.join(ROOT, '.mafia-server.pid') : null;
const PORT = process.env.PORT === undefined ? 4444 : Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65_535) throw new Error('Некорректный PORT');
const timerFromEnv = (name, fallback) => process.env[name] === undefined ? fallback : Math.max(1, Math.min(86_400_000, Number(process.env[name]) || fallback));
const RULES = Object.freeze({ minPlayers: 6, maxPlayers: 20, presenceTimeoutMs: timerFromEnv('MAFIA_PRESENCE_TIMEOUT_MS', 5_000), lobbyMs: timerFromEnv('MAFIA_LOBBY_MS', 60_000), nightMs: timerFromEnv('MAFIA_NIGHT_MS', 90_000), discussionMs: timerFromEnv('MAFIA_DISCUSSION_MS', 180_000), speechMs: timerFromEnv('MAFIA_SPEECH_MS', 30_000), voteMs: timerFromEnv('MAFIA_VOTE_MS', 60_000), revoteMs: timerFromEnv('MAFIA_REVOTE_MS', 30_000) });
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

fs.mkdirSync(DATA_DIR, { recursive: true });
const rooms = store.load('rooms');
const accounts = store.load('accounts');
const sessions = store.load('sessions');
const bans = store.load('bans');
const passwordResets = store.load('passwordResets');
function saveRooms() { store.save('rooms', rooms); }
function saveAccounts() { store.save('accounts', accounts); }
function saveSessions() { store.save('sessions', sessions); }
function saveBans() { store.save('bans', bans); }
function savePasswordResets() { store.save('passwordResets', passwordResets); }
function saveAdminLog() { store.save('adminLog', adminLog); }
function saveGameSettings() { store.save('gameSettings', gameSettings); }
const loadedAdminLog = store.load('adminLog', []);
const adminLog = Array.isArray(loadedAdminLog) ? loadedAdminLog : [];
const BOT_PERSONALITIES = ['friendly', 'jokester', 'sharp', 'chaotic', 'gentle'];
const gameSettings = { teasingHumor: false, botPersonalityPool: [...BOT_PERSONALITIES], roleRevealTestRooms: false, mafiaKillRoleVisibility: 'none', townVoteRoleVisibility: 'none', bonusesEnabled: false, bonusIntervalSeconds: 604_800, ...store.load('gameSettings') };
gameSettings.smtp ||= { host: '', port: 587, encryption: 'starttls', username: '', password: '', from: '' };
if (process.env.MAFIA_BONUSES_ENABLED === 'true') gameSettings.bonusesEnabled = true;
if (process.env.MAFIA_BONUS_INTERVAL_SECONDS !== undefined) gameSettings.bonusIntervalSeconds = Math.max(3_600, Math.min(31_536_000, Number(process.env.MAFIA_BONUS_INTERVAL_SECONDS) || 604_800));
if (!Array.isArray(gameSettings.botPersonalityPool)) gameSettings.botPersonalityPool = [...BOT_PERSONALITIES];
gameSettings.botPersonalityPool = gameSettings.botPersonalityPool.filter((personality) => BOT_PERSONALITIES.includes(personality));
gameSettings.autoFillBots = typeof gameSettings.autoFillBots === 'boolean' ? gameSettings.autoFillBots : true;
gameSettings.humanWaitSeconds = Number.isInteger(gameSettings.humanWaitSeconds) && gameSettings.humanWaitSeconds >= 1 && gameSettings.humanWaitSeconds <= 86_400 ? gameSettings.humanWaitSeconds : 60;
gameSettings.startDelaySeconds = Number.isInteger(gameSettings.startDelaySeconds) && gameSettings.startDelaySeconds >= 0 && gameSettings.startDelaySeconds <= 86_400 ? gameSettings.startDelaySeconds : Math.round(RULES.lobbyMs / 1000);
const timers = new Map();
const botChatTimers = new Map();

function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function normalizeLogin(value) { return String(value || '').trim().normalize('NFKC').toLocaleLowerCase('ru-RU'); }
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function initializeConfiguredAdmin() {
  const envUsername = process.env.MAFIA_ADMIN_USERNAME;
  const envPassword = process.env.MAFIA_ADMIN_PASSWORD;
  if ((envUsername === undefined) !== (envPassword === undefined)) throw new Error('MAFIA_ADMIN_USERNAME и MAFIA_ADMIN_PASSWORD нужно задавать вместе');
  if (envUsername === undefined || (envUsername === '' && envPassword === '')) return;
  const username = String(envUsername).trim().normalize('NFKC');
  const password = String(envPassword);
  if (username.length < 3 || username.length > 24 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) throw new Error('Некорректный MAFIA_ADMIN_USERNAME');
  if (password.length < 1 || password.length > 128) throw new Error('MAFIA_ADMIN_PASSWORD должен содержать от 1 до 128 символов');

  let account = Object.values(accounts).find((item) => normalizeLogin(item.username) === normalizeLogin(username));
  if (!account) account = Object.values(accounts).filter((item) => item.isAdmin).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (!account) {
    account = { id: crypto.randomUUID(), peacefulLevel: 0, mafiaLevel: 0, createdAt: Date.now() };
    accounts[account.id] = account;
  }
  for (const item of Object.values(accounts)) item.isAdmin = item.id === account.id;
  const salt = crypto.randomBytes(16).toString('hex');
  account.username = username; account.salt = salt; account.passwordHash = passwordHash(password, salt);
  account.peacefulLevel ??= 0; account.mafiaLevel ??= 0;
  account.bonuses ||= [];
  if (bans[account.id]) { delete bans[account.id]; saveBans(); }
  saveAccounts();
}
initializeConfiguredAdmin();
function adminExists() { return Object.values(accounts).some((account) => account.isAdmin); }
function smtpSettingsReady() { return Boolean(gameSettings.smtp.host && gameSettings.smtp.port && gameSettings.smtp.from); }
function publicSettings() { const { password, ...smtp } = gameSettings.smtp; return { ...gameSettings, smtp: { ...smtp, passwordConfigured: Boolean(password) } }; }
function safeAccount(account) { return { id: account.id, username: account.username, peacefulLevel: account.peacefulLevel, mafiaLevel: account.mafiaLevel, hidePeacefulLevel: Boolean(account.hidePeacefulLevel), hideMafiaLevel: Boolean(account.hideMafiaLevel), bonuses: account.bonuses || [], nextBonusAt: account.nextBonusAt || null, isAdmin: Boolean(account.isAdmin), banned: Boolean(bans[account.id]) }; }
function grantBonusIfDue(account, now = Date.now()) {
  const eligible = Number(account.peacefulLevel) >= 10 || Number(account.mafiaLevel) >= 10;
  if (!gameSettings.bonusesEnabled || !eligible) return false;
  account.bonuses ||= [];
  // Grant the first eligible item immediately; subsequent items follow the configured interval.
  const nextAt = Number(account.nextBonusAt) || now;
  account.nextBonusAt = nextAt;
  if (now < nextAt) return false;
  const pool = [];
  for (const [field, team] of [['peacefulLevel', 'town'], ['mafiaLevel', 'mafia']]) {
    for (let threshold = 10; threshold <= Math.min(90, Number(account[field]) || 0); threshold += 10) pool.push({ threshold, team, key: `${team}-${threshold}`, effect: bonusEffect(threshold) });
  }
  const reward = randomItem(pool);
  if (!reward) return false;
  account.bonuses.push({ id: crypto.randomUUID(), ...reward, grantedAt: now, usedAt: null });
  account.nextBonusAt = now + gameSettings.bonusIntervalSeconds * 1000;
  return true;
}
for (const account of Object.values(accounts)) {
  account.bonuses ||= [];
  if (gameSettings.bonusesEnabled && grantBonusIfDue(account)) saveAccounts();
}
function issueSession(account) { const token = crypto.randomBytes(32).toString('base64url'); sessions[crypto.createHash('sha256').update(token).digest('hex')] = account.id; saveSessions(); return token; }
function currentAccount(req, optional = false) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { if (optional) return null; fail('Войдите в аккаунт', 401); }
  const accountId = sessions[crypto.createHash('sha256').update(token).digest('hex')]; const account = accounts[accountId];
  if (!account) { if (optional) return null; fail('Сессия завершена. Войдите снова.', 401); }
  if (grantBonusIfDue(account)) saveAccounts();
  return account;
}
function requireAdmin(req) { const account = currentAccount(req); if (!account.isAdmin) fail('Требуются права администратора', 403); return account; }
function requirePlayable(account) { if (bans[account.id]) fail('Ваш аккаунт заблокирован для игры', 403); }
function logAdmin(admin, action, details) { adminLog.push({ adminId: admin.id, adminName: admin.username, action, details, at: Date.now() }); if (adminLog.length > 500) adminLog.splice(0, adminLog.length - 500); saveAdminLog(); }
function removePlayerFromRoom(room, player, adminMode = false) {
  if (room.phase === 'ended') fail('Завершённую игру нельзя модерировать');
  if (room.phase === 'lobby') {
    room.players = room.players.filter((p) => p.id !== player.id);
    syncLobbyTimer(room);
  } else if (room.phase !== 'ended') {
    if (!adminMode) player.forfeited = true;
    if (!adminMode) player.leftRoom = true;
    player.alive = false; player.connected = false; player.lastSeenAt = null;
    if (adminMode) player.kicked = true;
    if (room.phase === 'night') {
      delete room.night?.votes?.[player.id]; delete room.night?.checks?.[player.id]; delete room.night?.protections?.[player.id];
    }
    if (room.votes) delete room.votes[player.id];
    if (room.phase === 'speeches' && room.speakerOrder[room.speakerIndex] === player.id) { room.speakerIndex++; nextSpeaker(room); }
    if ((room.phase === 'voting' || room.phase === 'revote') && live(room).every((p) => room.votes[p.id])) finishVote(room);
    if (room.phase === 'night' && nightReady(room)) finishNight(room);
    endIfWon(room);
  }
  announce(room, adminMode ? `${player.name} был удалён администратором.` : `${player.name} покинул игру.`);
}
function roomFor(code) { const room = rooms[String(code || '').toUpperCase()]; if (!room) fail('Комната не найдена', 404); return room; }
function playerFor(room, id) { const p = room.players.find((item) => item.id === id); if (!p) fail('Игрок не найден', 404); return p; }
function activeParticipation(accountId) {
  for (const room of Object.values(rooms)) {
    if (room.phase === 'ended') continue;
    const player = room.players.find((entry) => entry.accountId === accountId && !entry.kicked && !entry.forfeited && !entry.leftRoom);
    if (player) return { room, player };
  }
  return null;
}
function live(room) { return room.players.filter((p) => p.alive); }
function isMafia(p) { return p.team === 'mafia'; }
function refreshPresence(room, seenPlayerId = null) {
  const now = Date.now();
  if (seenPlayerId) {
    const seen = room.players.find((player) => player.id === seenPlayerId);
    if (seen && !seen.kicked) seen.lastSeenAt = now;
  }
  for (const player of room.players) player.connected = !player.kicked && isConnected(player.lastSeenAt, now, RULES.presenceTimeoutMs);
}
const NARRATOR_LINES = {
  lobby: [
    'Я бы предложил кофе, но в этой комнате уже достаточно бодрствующих.', 'Места есть. Подозрения пока бесплатные.',
    'Системный ведущий на посту. Системный кофе закончился.', 'Пока ждём остальных, можете потренировать невинный вид.',
    'Не волнуйтесь: я всё запомню. Я сервер.', 'Комната собирается. Стулья виртуальные, зато спинки у всех ровные.',
    'До начала можно обсудить погоду. Я проверил: подозрительно обычная.', 'Участники прибывают. Мой любимый вид спорта — статистика онлайна.',
    'Добро пожаловать! Гардероб слева, тайные планы — при себе.', 'Набор открыт. Рекрутер обещал печеньки, но он тоже бот.',
    'Проверьте связь и невозмутимость. Второе иногда лагает чаще.', 'Свободные места ещё есть. Виртуальная мебель не скрипит — пока.',
    'Команда почти собрана. Я уже пересчитал вас дважды, для спокойствия.', 'Можно знакомиться. Я представлюсь: ведущий, модель — серверная.',
    'Чем больше игроков, тем больше версий событий. И тем длиннее список вкладок у меня.'
  ],
  night: [
    'Ночь тихая. Даже мафия сегодня без голосового чата.', 'Город спит, сервер не спит. У кого-то из нас есть работа.',
    'Никаких переговоров. Только выбор и тяжёлые последствия.', 'В темноте не видно лиц. Зато отлично видно кнопки.',
    'Мафия, выберите цель молча. Я умею читать клики.', 'Наступила ночь. Пожалуйста, не будите город без веской причины.',
    'Город спит крепко. Серверу опять досталась ночная смена.', 'Тишина такая, что слышно, как таймер делает вид, будто не торопится.',
    'Ночное совещание проходит без протокола. Хотя протокол у меня всё равно есть.', 'Кнопки доступны, разговоры — нет. У интерфейса сегодня строгий режим.',
    'Все ночные решения принимаются молча. Даже мой внутренний монолог.', 'Время тайных действий. У меня секретов нет, только журналы событий.',
    'Ночь — отличное время подумать. Но только в своей секретной роли.', 'Город видит сны, сервер проверяет таймеры. У каждого свои хобби.',
    'Никаких подсказок от ведущего: я нейтрален, как чай без сахара.', 'Тише, город спит. Клавиатуру тоже можно уложить пораньше.'
  ],
  discussion: [
    'Три минуты на разговоры. Постарайтесь уложить подозрения в предложения.', 'Город открыт для дискуссии. Капслок не считается доказательством.',
    'Говорите смело. Логи всё равно переживут эту партию.', 'Убедительные аргументы приветствуются. Драматичные паузы — тоже.',
    'Пока можно говорить всем. Скоро микрофон будет по очереди.', 'Свободное обсуждение началось. Вежливость не ограничена таймером.',
    'Делитесь версиями. Версии браузера можно оставить при себе.', 'Давайте по фактам. Интонация «я точно знаю» тоже пока не улика.',
    'Обсуждение открыто. Можно передавать слово — мысленно, пока чат общий.', 'Три минуты: достаточно для версии, уточнения и одного «а вот теперь интересно».',
    'Слушаем друг друга. Это как голосование, только без кнопки «перебить».', 'Чат открыт. Пусть аргументы будут ясными, а пробелы — между словами.',
    'Самое время проверить гипотезы. Калькулятором пользоваться можно, сервер не ревнует.', 'Город обсуждает. Таймер молчит громче всех.',
    'Если версия изменилась — ничего страшного. Даже карта иногда просит перестроить маршрут.', 'Говорите по существу. Но небольшая театральная пауза входит в комплект.'
  ],
  speeches: [
    'Слово по кругу. Перебивать нельзя — даже если очень хочется.', 'Каждому достанется очередь. Сервер следит за порядком и за запятыми.',
    'Говорит один игрок. Остальные готовят лица «я так и знал».', 'Короткая речь лучше длинной паузы. Хотя пауза тоже бывает красноречивой.',
    'Очередь выступлений: демократия, но с таймером.', 'Микрофон виртуальный, очередь настоящая. Передаю слово аккуратно.',
    'У каждого есть время высказаться. У меня тоже, но я уже всё сказал.', 'Пока говорит один игрок, остальные могут репетировать внимательное кивание.',
    'Очередь идёт по списку. Список не волнуется и не забывает, кто следующий.', 'Выступайте спокойно: таймер считает секунды, а не запятые.',
    'Слово следующему игроку. Аплодисменты оставим для финала и клавиатур.', 'Одна речь за раз. Даже мысли иногда полезно ставить в очередь.',
    'Сейчас ваш ход говорить. Ходить по комнате интерфейс пока не умеет.', 'Слушаем выступление. Внимание — единственная функция без кнопки отмены.',
    'Время для аргументов. Монолог на три сезона оставим сериалам.', 'Слово передано. Оно виртуальное, поэтому не уроните.'
  ],
  voting: [
    'Выбирайте внимательно. Палец быстрее мысли, но сервер запомнит оба.', 'Голосование открыто. Обвинения скоро станут статистикой.',
    'Время решить. Никакого давления — только таймер.', 'Ваш голос важен. Особенно если вы его действительно отправите.',
    'Голос можно сменить до конца таймера. Передумать — тоже стратегический ход.', 'Настал момент выбора. Кнопки сегодня особенно внимательно слушают.',
    'Голосуйте спокойно. Кнопка не кусается, она только считает.', 'Все голоса имеют вес. Мой голос — ноль, у меня даже руки виртуальные.',
    'Пора выбрать. Колебаться можно, но таймер умеет ждать только по расписанию.', 'Решение за вами. Я бы подбросил монетку, но это не входит в мои полномочия.',
    'Проверяйте имя перед нажатием. Интерфейс не умеет читать мысли — пока.', 'Голосование идёт. У каждого клика есть маленькая цифровая судьба.',
    'Если передумали — голос можно изменить. Даже сервер иногда перечитывает данные.', 'Выбирайте кандидата. Кнопка воздержаться сегодня называется «не голосовать».',
    'Все готовы? Не отвечайте хором, просто отправьте голос.', 'Голосование — это когда сомнения получают удобные кнопки.'
  ],
  revote: [
    'Переголосование. У лидеров есть шанс на второй раунд.', 'Ничья — редкий случай, когда даже сервер просит определиться.',
    'Только кандидаты-лидеры. Остальные могут выдохнуть на полминуты.', 'Снова выбираем. Математика сегодня не решила за город.',
    'Второй тур! Бюллетени те же, мысли могут быть новыми.', 'Голоса разделились так ровно, что линейка одобрила результат.',
    'Ещё один раунд выбора. Таймер обещал быть кратким и держит слово.', 'Кандидаты определены. Осталось определиться городу.',
    'Переголосование открыто. Повторный выбор — не ошибка, а функция.', 'Ничья дала городу паузу на размышление. Сервер тоже размышлял, но без результата.',
    'Только лидеры в списке. Остальные сегодня зрители собственной интриги.', 'Раунд номер два. Без музыкальной заставки, зато с тем же таймером.'
  ],
  dawn: [
    'Утро пришло. Оно не принесло кофе, зато принесло новости.', 'Город просыпается. Будильник сработал у всех по-разному.',
    'Рассвет объявлен. Солнце взошло по расписанию — редкий пример дисциплины.', 'Доброе утро! Насколько оно доброе, сейчас выясним.',
    'Город проснулся. Сервер был бодр всё это время, но не хвастается.', 'Ночь закончилась. Можно говорить, но сначала моргните пару раз.',
    'Солнце над городом. Тени стали короче, а версии — длиннее.', 'Наступило утро. Кофе в правила не входит, но никто не запрещает.',
    'Рассвет! Птицы поют, таймеры работают. У каждого свои обязанности.', 'Город проснулся и проверил чат. Привычки сильнее ночной тишины.'
  ],
  result: [
    'Итоги подведены. Сервер посчитал всё дважды, потому что любит точность.', 'Раунд завершён. Спасибо за игру и за бережное отношение к кнопкам.',
    'Партия окончена. Таймеры могут наконец выдохнуть.', 'Вот и финал. Все версии проверены, некоторые даже дважды.',
    'Игра завершена. Сервер сохраняет журнал и делает вид, что не устал.', 'Победа определена. Можно поздравить друг друга и размять пальцы.',
    'Финал наступил. Ни один пиксель не пострадал при подсчёте голосов.', 'Партия завершена. Спасибо, что доверили мне ваши таймеры.',
    'Результат готов. У сервера нет кубка, зато есть точный подсчёт.', 'Игра окончена. Обсуждать партию можно, спорить с арифметикой — по желанию.'
  ],
  tease: [
    'Эта версия звучит уверенно. Даже таймер на секунду перестал тикать.',
    'Подозрение принято. Оно уже заняло место в первом ряду.',
    'Такой аргумент заслужил отдельную полочку в архиве.',
    'У этой версии хорошая осанка. Проверим, выдержит ли она вопросы.',
    'Кто-то сегодня так убедителен, что даже запятые выстроились по порядку.',
    'Это заявление прозвучало громче, чем моя клавиатура в три часа ночи.',
    'Уверенность — прекрасная вещь. Особенно когда она подкреплена фактами.',
    'Похоже, у кого-то есть план. Надеюсь, он хотя бы сохранён в черновиках.',
    'Зал слушает. Ну, виртуальный зал. Стулья всё ещё молчат.',
    'Такой поворот я бы отметил в календаре. Если бы умел удивляться.',
    'Версия смелая. Она уже сама попросила слово следующей.',
    'Наблюдательность на высоте. Бинокль можно вернуть на место.',
    'Кто-то явно готовился к этому выступлению. Или просто хорошо выспался.',
    'Аргумент принят к рассмотрению. Комиссия состоит из меня и таймера.',
    'В этой комнате сегодня столько детективной работы, что лупа просит отпуск.',
    'Коротко и ясно. Даже мой журнал событий успел дочитать до конца.'
  ]
};
function say(room, text) {
  const key = room.narratorContext || (NARRATOR_LINES[room.phase] ? room.phase : 'lobby');
  const choices = [...(NARRATOR_LINES[key] || NARRATOR_LINES.lobby), ...(gameSettings.teasingHumor ? NARRATOR_LINES.tease : [])];
  return `${text} ${choices[crypto.randomInt(choices.length)]}`;
}
function announce(room, message, context = null) { room.narratorContext = context; room.log.push({ text: say(room, message), at: Date.now() }); room.narratorContext = null; room.log = room.log.slice(-100); }
function winningTeam(room) { return resolveWinningTeam(room.players); }
function winner(room) { const team = winningTeam(room); return team === 'town' ? 'Город победил!' : team === 'mafia' ? 'Мафия победила!' : null; }
function clearTimer(room) { const handle = timers.get(room.code); if (handle) clearTimeout(handle); timers.delete(room.code); }
function clearBotChatTimer(room) { const handle = botChatTimers.get(room.code); if (handle) clearTimeout(handle); botChatTimers.delete(room.code); }
function armTimer(room, ms, callback) {
  clearTimer(room); room.deadline = Date.now() + ms;
  const handle = setTimeout(() => { timers.delete(room.code); callback(); saveRooms(); }, ms);
  timers.set(room.code, handle);
}
function scheduleStart(room) {
  clearTimer(room); room.lobbyTimerKind = 'start';
  const delay = gameSettings.startDelaySeconds * 1000;
  if (delay <= 0) { room.deadline = null; room.lobbyTimerKind = null; startGame(room); return; }
  room.deadline = Date.now() + delay;
  setLobbyTimer(room);
}
function finishHumanWait(room) {
  room.deadline = null; room.lobbyTimerKind = null;
  if (room.phase !== 'lobby' || room.players.length >= RULES.minPlayers) return;
  const added = fillBotSeats(room, RULES.minPlayers);
  if (added) announce(room, `Ожидание людей завершено. Системный ведущий добавил ${added} тестовых ботов. Начался отсчёт до старта.`);
  if (room.players.length >= RULES.minPlayers) scheduleStart(room);
}
function scheduleHumanFill(room, delay = gameSettings.humanWaitSeconds * 1000) {
  if (room.phase !== 'lobby' || !gameSettings.autoFillBots || room.players.length >= RULES.minPlayers || !room.players.some((player) => !player.bot)) return;
  clearTimer(room); room.lobbyTimerKind = 'human-fill';
  armTimer(room, delay, () => finishHumanWait(room));
}
function syncLobbyTimer(room) {
  if (room.phase !== 'lobby') return;
  if (!room.players.some((player) => !player.bot)) {
    clearTimer(room); room.deadline = null; room.lobbyTimerKind = null; return;
  }
  if (room.players.length >= RULES.minPlayers) {
    if (room.lobbyTimerKind !== 'start' || !room.deadline) {
      if (gameSettings.startDelaySeconds > 0) announce(room, 'Минимальный состав набран. Начался отсчёт до старта.');
      scheduleStart(room);
    }
  } else if (gameSettings.autoFillBots) {
    if (room.lobbyTimerKind !== 'human-fill' || !room.deadline) scheduleHumanFill(room);
  } else if (room.lobbyTimerKind === 'human-fill') {
    clearTimer(room); room.deadline = null; room.lobbyTimerKind = null;
  }
}
function refreshLobbyTimers(previous) {
  for (const room of Object.values(rooms)) {
    if (room.phase !== 'lobby') continue;
    if (room.players.length >= RULES.minPlayers) {
      if (previous.startDelaySeconds !== gameSettings.startDelaySeconds || room.lobbyTimerKind !== 'start') scheduleStart(room);
    } else if (previous.autoFillBots !== gameSettings.autoFillBots || previous.humanWaitSeconds !== gameSettings.humanWaitSeconds) {
      if (gameSettings.autoFillBots) scheduleHumanFill(room); else syncLobbyTimer(room);
    } else if (!room.deadline) syncLobbyTimer(room);
    else if (!gameSettings.autoFillBots && room.lobbyTimerKind === 'human-fill') syncLobbyTimer(room);
  }
  saveRooms();
}
function publicRoom(room, playerId, viewerAccountId = null) {
  const viewer = room.players.find((p) => p.id === playerId);
  const showMafia = viewer?.team === 'mafia';
  const canSeeHiddenLevels = Boolean(accounts[viewerAccountId]?.isAdmin && viewer?.accountId === viewerAccountId);
  const privatelyKnownRoles = new Map((viewer?.role === 'detective' ? viewer.investigationHistory || [] : []).filter((entry) => entry.role).map((entry) => [entry.targetId, entry.role]));
  const currentCheck = viewer?.role === 'detective' ? room.night?.checks?.[viewer.id] : null;
  if (currentCheck?.role) privatelyKnownRoles.set(currentCheck.targetId, currentCheck.role);
  return {
    code: room.code, phase: room.phase, day: room.day, deadline: room.deadline || null,
    lobbyTimerKind: room.lobbyTimerKind || null, autoFillBots: gameSettings.autoFillBots,
    minPlayers: RULES.minPlayers, maxPlayers: RULES.maxPlayers, winner: room.winner || null,
    players: room.players.map((p) => {
      const account = accounts[p.accountId];
      const isOwner = account?.id === viewerAccountId;
      return { id: p.id, name: p.name, bot: Boolean(p.bot), personality: p.bot ? p.personality || 'neutral' : undefined, alive: p.alive, connected: p.connected,
      peacefulLevel: account && (isOwner || canSeeHiddenLevels || !account.hidePeacefulLevel) ? Number(account.peacefulLevel) || 0 : null,
      mafiaLevel: account && (isOwner || canSeeHiddenLevels || !account.hideMafiaLevel) ? Number(account.mafiaLevel) || 0 : null,
      role: p.id === playerId || room.phase === 'ended' || privatelyKnownRoles.has(p.id) || room.roleReveals?.[p.id]?.viewers?.includes(playerId) || (gameSettings.roleRevealTestRooms && room.testRoleReveal && !p.alive) ? p.role : undefined,
      team: (p.id === playerId || room.phase === 'ended' || showMafia) ? p.team : undefined,
      hasSpoken: Boolean(room.spoken?.includes(p.id)) };
    }),
    you: viewer ? { id: viewer.id, role: viewer.role, team: viewer.team, alive: viewer.alive, lastProtectedId: viewer.role === 'doctor' ? viewer.lastProtectedId || null : undefined, investigationHistory: viewer.role === 'detective' ? (viewer.investigationHistory || []).map((entry) => ({ ...entry, targetName: room.players.find((p) => p.id === entry.targetId)?.name || 'Неизвестный игрок' })) : undefined, mayorRevealed: Boolean(viewer.mayorRevealed), teamChoice: room.teamChoices?.[viewer.accountId] || null, teamChoiceAvailable: viewer.accountId && room.phase === 'lobby' ? [Number(accounts[viewer.accountId]?.peacefulLevel) >= 100 ? 'town' : null, Number(accounts[viewer.accountId]?.mafiaLevel) >= 100 ? 'mafia' : null].filter(Boolean) : [] } : null,
    accountBonuses: viewer?.accountId ? (accounts[viewer.accountId]?.bonuses || []).filter((bonus) => !bonus.usedAt).map((bonus) => ({ id: bonus.id, threshold: bonus.threshold, team: bonus.team, effect: bonus.effect || bonusEffect(bonus.threshold), ...BONUS_EFFECTS[bonus.effect || bonusEffect(bonus.threshold)] })) : [],
    mafia: showMafia ? room.players.filter((p) => isMafia(p)).map((p) => p.id) : [],
    votes: room.phase === 'voting' || room.phase === 'revote' ? room.players.filter((p) => room.votes?.[p.id]).map((p) => ({ voterId: p.id, targetId: room.votes[p.id], weight: room.doubleVotes?.[p.id] ? 2 : 1 })) : [],
    night: viewer?.role === 'detective' || viewer?.role === 'don' ? { checkedId: room.night?.checks?.[viewer.id]?.targetId || null, isMafia: room.night?.checks?.[viewer.id]?.isMafia, targetRole: viewer?.role === 'detective' ? room.night?.checks?.[viewer.id]?.targetRole || null : undefined, blocked: Boolean(room.night?.checks?.[viewer.id]?.blocked) }
      : viewer?.role === 'doctor' ? { protectedId: room.night?.protections?.[viewer.id] || null }
        : showMafia ? { votes: room.night?.votes || {} } : undefined,
    currentSpeaker: room.speakerOrder?.[room.speakerIndex] || null,
    candidates: room.candidates || [], log: room.log.slice(-30), chat: room.phase === 'discussion' || room.phase === 'speeches' || room.phase === 'voting' || room.phase === 'revote' ? (room.chat || []).slice(-80) : []
  };
}
function awardProgress(room) {
  if (room.progressAwarded) return;
  room.progressAwarded = true; const winning = winningTeam(room); let changed = false;
  for (const player of room.players) {
    const account = accounts[player.accountId]; if (!account || player.forfeited || !player.team) continue;
    const field = player.team === 'mafia' ? 'mafiaLevel' : 'peacefulLevel';
    const gain = progressGain({ team: player.team, winning, forfeited: player.forfeited, currentLevel: account[field] });
    if (!gain) continue;
    account[field] = Math.min(100, (Number(account[field]) || 0) + gain); changed = true;
    grantBonusIfDue(account);
  }
  if (changed) saveAccounts();
}
function endIfWon(room) { const result = winner(room); if (!result) return false; clearTimer(room); clearBotChatTimer(room); room.phase = 'ended'; room.deadline = null; room.winner = result; announce(room, result, 'result'); awardProgress(room); return true; }
function runBotDayVotes(room) {
  if (room.phase !== 'voting' && room.phase !== 'revote') return;
  for (const bot of live(room).filter((player) => player.bot)) {
    const target = botTarget(room, bot, room.phase === 'revote' ? room.candidates : null);
    if (target) room.votes[bot.id] = target.id;
  }
}
function addBotMessage(room, bot, speech = false) {
  room.chat ||= [];
  const text = botLine(room, bot);
  room.chat.push({ playerId: bot.id, name: bot.name, text, at: Date.now(), bot: true, ...(speech ? { speech: true } : {}) });
  room.chat = room.chat.slice(-200);
}
function scheduleBotChat(room) {
  clearBotChatTimer(room);
  if (room.phase !== 'discussion') return;
  const delay = botReplyDelay(room);
  const handle = setTimeout(() => {
    botChatTimers.delete(room.code);
    if (room.phase !== 'discussion') return;
    const bot = randomItem(live(room).filter((player) => player.bot));
    if (bot) { addBotMessage(room, bot); saveRooms(); }
    scheduleBotChat(room);
  }, delay);
  botChatTimers.set(room.code, handle);
}
function fillBotSeats(room, targetCount) {
  const addCount = Math.max(0, Math.min(targetCount, RULES.maxPlayers) - room.players.length);
  for (let index = 0; index < addCount; index++) {
    const number = room.players.filter((player) => player.bot).length + 1;
    const personality = randomItem(gameSettings.botPersonalityPool) || 'neutral';
    room.players.push({ id: crypto.randomUUID(), name: `Тестовый бот ${String(number).padStart(2, '0')}`, bot: true, personality, alive: true, connected: true, lastSeenAt: Date.now() });
  }
  return addCount;
}
function runBotNight(room) {
  const actors = live(room);
  const targets = actors.filter((player) => !isMafia(player));
  const mafiaTarget = randomItem(targets);
  for (const bot of actors.filter((player) => player.bot && isMafia(player) && player.role !== 'don')) {
    const target = botTarget(room, bot, null, { hidden: true }) || mafiaTarget;
    if (target) room.night.votes[bot.id] = target.id;
  }
  const detective = actors.find((player) => player.role === 'detective' && player.bot);
  const detectiveTarget = detective && randomItem(actors.filter((player) => player.id !== detective.id));
  if (detectiveTarget) room.night.checks[detective.id] = { targetId: detectiveTarget.id, isMafia: isMafia(detectiveTarget) };
  const don = actors.find((player) => player.role === 'don' && player.bot);
  const donTarget = don && randomItem(actors.filter((player) => player.id !== don.id));
  if (donTarget) room.night.checks[don.id] = { targetId: donTarget.id, isMafia: donTarget.role === 'detective' };
  for (const doctor of actors.filter((player) => player.role === 'doctor' && player.bot)) {
    const doctorTargets = actors.filter((player) => player.id !== doctor.id && player.id !== doctor.lastProtectedId);
    const target = randomItem(doctorTargets); if (target) room.night.protections[doctor.id] = target.id;
  }
}
function runBotVotes(room) {
  runBotDayVotes(room);
}
function startNight(room) {
  clearTimer(room); room.day = (room.day || 0) + 1; room.phase = 'night'; room.deadline = null;
  room.night = { votes: {}, checks: {}, protections: {} }; room.votes = {}; announce(room, `Ночь ${room.day}. Мафия и специальные роли выбирают действие.`);
  runBotNight(room);
  armTimer(room, RULES.nightMs, () => finishNight(room));
  if (nightReady(room)) finishNight(room);
}
function finishNight(room) {
  if (room.phase !== 'night') return;
  clearTimer(room);
  const actors = live(room);
  const liveIds = new Set(actors.map((player) => player.id));
  const counts = {}; for (const [voterId, target] of Object.entries(room.night?.votes || {})) if (liveIds.has(voterId)) counts[target] = (counts[target] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts)); const top = Object.keys(counts).filter((id) => counts[id] === max && max > 0);
  const victim = top.length === 1 ? room.players.find((p) => p.id === top[0]) : null;
  // Moderated players leave active play without ending their participation record.
  const moderatedIds = new Set(room.players.filter((player) => player.kicked).map((player) => player.id));
  const detective = actors.find((p) => p.role === 'detective');
  const checked = detective && room.night.checks?.[detective.id];
  if (checked) {
    detective.investigationHistory ||= [];
    detective.investigationHistory.push({ day: room.day, targetId: checked.targetId, role: checked.targetRole || null, blocked: Boolean(checked.blocked) });
    detective.investigationHistory = detective.investigationHistory.slice(-50);
    announce(room, `Комиссар проверил игрока. Результат видит только он.`);
  }
  const don = actors.find((p) => p.role === 'don');
  if (don && room.night.checks?.[don.id]) announce(room, 'Дон проверил одного игрока. Результат известен только дону.');
  const protectedIds = new Set(Object.entries(room.night?.protections || {})
    .filter(([doctorId]) => liveIds.has(doctorId))
    .map(([, targetId]) => targetId));
  for (const doctor of actors.filter((player) => player.role === 'doctor')) doctor.lastProtectedId = room.night?.protections?.[doctor.id] || null;
  if (victim?.alive && !isMafia(victim) && protectedIds.has(victim.id) && !moderatedIds.has(victim.id)) announce(room, 'Ночью доктор спас цель мафии. Все дожили до рассвета.');
  else if (victim?.alive && !isMafia(victim)) {
    victim.alive = false;
    const viewers = roleRevealViewers({ players: room.players, votes: room.night?.votes, victimId: victim.id, cause: 'mafia-kill', visibility: gameSettings.mafiaKillRoleVisibility });
    if (viewers.length) { room.roleReveals ||= {}; room.roleReveals[victim.id] = { role: victim.role, viewers, cause: 'mafia-kill', day: room.day }; }
    announce(room, `На рассвете город обнаружил, что ${victim.name} выбыл.`);
  }
  else announce(room, 'Наступило утро. Этой ночью никто не выбыл.');
  if (endIfWon(room)) return;
  room.phase = 'discussion'; room.chat = []; room.votes = {}; announce(room, 'Начинается свободное обсуждение на три минуты.', 'dawn');
  scheduleBotChat(room);
  armTimer(room, RULES.discussionMs, () => startSpeeches(room));
}
function nightReady(room) {
  const mafia = live(room).filter((p) => isMafia(p) && p.role !== 'don');
  const detective = live(room).find((p) => p.role === 'detective');
  const don = live(room).find((p) => p.role === 'don');
  const doctor = live(room).find((p) => p.role === 'doctor');
  return mafia.every((p) => room.night?.votes?.[p.id]) && (!detective || room.night?.checks?.[detective.id]) && (!don || room.night?.checks?.[don.id]) && (!doctor || room.night?.protections?.[doctor.id]);
}
function startSpeeches(room) {
  if (room.phase !== 'discussion') return;
  clearBotChatTimer(room);
  room.phase = 'speeches'; room.speakerOrder = live(room).map((p) => p.id); room.spoken = []; room.speakerIndex = 0; announce(room, 'Свободное обсуждение закончено. Начинается круг выступлений.');
  nextSpeaker(room);
}
function nextSpeaker(room) {
  clearTimer(room);
  while (room.speakerIndex < room.speakerOrder.length) {
    const next = playerFor(room, room.speakerOrder[room.speakerIndex]);
    if (!next.alive) { room.speakerIndex++; continue; }
    if (next.bot) {
      room.deadline = Date.now() + 300;
      addBotMessage(room, next, true); room.spoken ||= []; room.spoken.push(next.id); room.speakerIndex++;
      armTimer(room, 300, () => nextSpeaker(room)); return;
    }
    break;
  }
  if (room.speakerIndex >= room.speakerOrder.length) { startVote(room, false); return; }
  const speaker = playerFor(room, room.speakerOrder[room.speakerIndex]); announce(room, `Слово игроку ${speaker.name}.`);
  armTimer(room, RULES.speechMs, () => { room.spoken ||= []; room.spoken.push(speaker.id); room.speakerIndex++; nextSpeaker(room); });
}
function startVote(room, revote, candidates = []) {
  clearTimer(room); room.phase = revote ? 'revote' : 'voting'; room.votes = {}; room.doubleVotes = room.nextDoubleVotes || {}; room.nextDoubleVotes = {}; room.candidates = candidates;
  announce(room, revote ? 'Переголосование между лидерами.' : 'Выступления закончены. Начинается голосование.');
  runBotDayVotes(room); runBotVotes(room);
  armTimer(room, revote ? RULES.revoteMs : RULES.voteMs, () => finishVote(room));
  if (live(room).every((player) => room.votes[player.id])) finishVote(room);
}
function finishVote(room) {
  if (room.phase !== 'voting' && room.phase !== 'revote') return;
  clearTimer(room);
  const top = voteLeaders(room.votes, live(room).map((player) => player.id), room.phase === 'revote' ? room.candidates : null, Object.keys(room.doubleVotes || {}));
  if (top.length > 1 && room.phase === 'voting') { startVote(room, true, top); return; }
  if (top.length === 1) {
    const removed = playerFor(room, top[0]); removed.alive = false;
    const viewers = roleRevealViewers({ players: room.players, votes: room.votes, victimId: removed.id, cause: 'town-vote', visibility: gameSettings.townVoteRoleVisibility });
    if (viewers.length) { room.roleReveals ||= {}; room.roleReveals[removed.id] = { role: removed.role, viewers, cause: 'town-vote', day: room.day }; }
    announce(room, `Город исключил ${removed.name}.`);
  }
  else announce(room, 'Голоса разделились. Никто не выбыл.');
  if (endIfWon(room)) return;
  startNight(room);
}
function startGame(room) {
  if (room.phase !== 'lobby') return;
  if (live(room).length < RULES.minPlayers) return;
  clearTimer(room);
  const players = room.players;
  const roles = roleSlots(players.length, { testSpecialRoles: Boolean(room.testSpecialRoles) });
  // Stable seat assignment for integration tests only; production always shuffles roles.
  if (process.env.MAFIA_TEST_SEED_ROLES !== '1') {
    for (let i = roles.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  }
  players.forEach((p, i) => { p.role = roles[i].role; p.team = roles[i].team; p.alive = true; });
  applyTeamChoices(room, roles);
  room.day = 0; room.deadline = null; room.lobbyTimerKind = null; room.winner = null; room.chat = []; room.speakerOrder = []; room.speakerIndex = 0;
  announce(room, 'Состав набран. Роли розданы. Системный ведущий начинает игру.'); startNight(room);
}
function applyTeamChoices(room, roles) {
  for (const [accountId, desiredTeam] of Object.entries(room.teamChoices || {})) {
    const chosen = room.players.find((player) => player.accountId === accountId);
    if (!chosen || chosen.team === desiredTeam) continue;
    const displaced = randomItem(room.players.filter((player) => player.team === desiredTeam && ['villager', 'mafia'].includes(player.role)));
    if (!displaced) continue;
    displaced.team = chosen.team; displaced.role = displaced.team === 'mafia' ? 'mafia' : 'villager';
    chosen.team = desiredTeam; chosen.role = desiredTeam === 'mafia' ? 'mafia' : 'villager';
  }
  if (!Object.keys(room.teamChoices || {}).length) return;
  for (const team of ['town', 'mafia']) {
    const teamPlayers = room.players.filter((player) => player.team === team);
    const teamRoles = roles.filter((slot) => slot.team === team).map((slot) => slot.role);
    for (let index = teamRoles.length - 1; index > 0; index--) { const other = crypto.randomInt(index + 1); [teamRoles[index], teamRoles[other]] = [teamRoles[other], teamRoles[index]]; }
    teamPlayers.forEach((player, index) => { player.role = teamRoles[index]; });
  }
}
function roomObject(code) { return { code, phase: 'lobby', day: 0, deadline: null, lobbyTimerKind: null, players: [], votes: {}, night: {}, log: [], chat: [], speakerOrder: [], speakerIndex: 0, candidates: [] }; }
function ensureTimers() {
  for (const room of Object.values(rooms)) {
    // Migrate prototype rooms whose host used to occupy a player slot.
    room.players = (room.players || []).filter((p) => !p.host);
    room.players.forEach((p) => { p.connected = false; p.lastSeenAt = null; p.alive ??= true; });
    room.log ||= []; room.chat ||= []; room.night ||= {}; room.votes ||= {};
    if (room.phase === 'lobby' && !room.players.some((player) => !player.bot)) { clearTimer(room); room.deadline = null; room.lobbyTimerKind = null; }
    else if (room.phase === 'lobby' && room.players.length >= RULES.minPlayers) {
      if (room.lobbyTimerKind === 'start' && room.deadline && Date.now() >= room.deadline) startGame(room);
      else if (room.lobbyTimerKind === 'start' && room.deadline) setLobbyTimer(room);
      else scheduleStart(room);
    } else if (room.phase === 'lobby' && gameSettings.autoFillBots) {
      if (room.lobbyTimerKind === 'human-fill' && room.deadline) scheduleHumanFill(room, Math.max(0, room.deadline - Date.now()));
      else scheduleHumanFill(room);
    } else if (room.phase === 'lobby') { clearTimer(room); room.deadline = null; room.lobbyTimerKind = null; }
    else if (room.phase === 'night' && room.deadline) armTimer(room, Math.max(0, room.deadline - Date.now()), () => finishNight(room));
    else if (room.phase === 'discussion' && room.deadline) armTimer(room, Math.max(0, room.deadline - Date.now()), () => startSpeeches(room));
    else if (room.phase === 'speeches' && room.deadline) armTimer(room, Math.max(0, room.deadline - Date.now()), () => { room.speakerIndex++; nextSpeaker(room); });
    else if ((room.phase === 'voting' || room.phase === 'revote') && room.deadline) armTimer(room, Math.max(0, room.deadline - Date.now()), () => finishVote(room));
  }
  for (const room of Object.values(rooms)) if (room.phase === 'discussion') scheduleBotChat(room);
}
function setLobbyTimer(room) { room.lobbyTimerKind = 'start'; armTimer(room, Math.max(0, room.deadline - Date.now()), () => { room.lobbyTimerKind = null; room.deadline = null; if (room.phase === 'lobby' && room.players.length >= RULES.minPlayers) startGame(room); }); }
ensureTimers();

async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) fail('Слишком большой запрос', 413); } try { return raw ? JSON.parse(raw) : {}; } catch { fail('Некорректный JSON'); } }
async function api(req, res, url) {
  try {
    const input = req.method === 'POST' ? await body(req) : {};
    const route = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/api/setup-status') { send(res, 200, { needsSetup: !adminExists() }); return; }
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const username = String(input.username || '').trim().normalize('NFKC'); const key = normalizeLogin(username); const password = String(input.password || '');
      if (username.length < 3 || username.length > 24 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) fail('Логин: 3–24 символа, буквы, цифры, точка, дефис или подчёркивание');
      if (password.length < 1 || password.length > 128) fail('Пароль должен содержать от 1 до 128 символов');
      const email = String(input.email || '').trim().toLowerCase();
      if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail('Укажите корректный адрес электронной почты');
      if (Object.values(accounts).some((account) => normalizeLogin(account.username) === key)) fail('Такой логин уже занят');
      const isFirstAdmin = !adminExists();
      if (isFirstAdmin && !email) fail('Для первичной настройки администратора укажите электронную почту');
      if (Object.values(accounts).some((account) => account.email && account.email.toLowerCase() === email)) fail('Этот адрес уже используется');
      const salt = crypto.randomBytes(16).toString('hex'); const account = { id: crypto.randomUUID(), username, email, salt, passwordHash: passwordHash(password, salt), peacefulLevel: 0, mafiaLevel: 0, isAdmin: isFirstAdmin, createdAt: Date.now() };
      accounts[account.id] = account; saveAccounts(); const token = issueSession(account);
      send(res, 201, { account: safeAccount(account), token }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const username = normalizeLogin(input.username); const password = String(input.password || ''); if (password.length > 128) fail('Неверный логин или пароль', 401);
      const account = Object.values(accounts).find((item) => normalizeLogin(item.username) === username);
      if (!account || !crypto.timingSafeEqual(Buffer.from(passwordHash(password, account.salt), 'hex'), Buffer.from(account.passwordHash, 'hex'))) fail('Неверный логин или пароль', 401);
      send(res, 200, { account: safeAccount(account), token: issueSession(account) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/password/forgot') {
      const email = String(input.email || '').trim().toLowerCase();
      const account = Object.values(accounts).find((item) => item.email && item.email.toLowerCase() === email);
      if (account && smtpSettingsReady()) {
        const token = crypto.randomBytes(32).toString('base64url');
        for (const [oldKey, reset] of Object.entries(passwordResets)) if (reset.accountId === account.id) delete passwordResets[oldKey];
        passwordResets[crypto.createHash('sha256').update(token).digest('hex')] = { accountId: account.id, expiresAt: Date.now() + 30 * 60_000 };
        savePasswordResets();
        const origin = String(process.env.MAFIA_PUBLIC_URL || `http://${req.headers.host || `localhost:${PORT}`}`).replace(/\/$/, '');
        try { await smtpSend(gameSettings.smtp, account.email, 'Восстановление пароля Mafia', `Чтобы задать новый пароль, откройте ссылку (действует 30 минут):\n${origin}/?reset=${encodeURIComponent(token)}\n\nЕсли вы не запрашивали восстановление, проигнорируйте письмо.`); }
        catch (error) { console.error(`Не удалось отправить письмо восстановления: ${error.message}`); }
      }
      send(res, 200, { message: 'Если адрес зарегистрирован и почта настроена, письмо для восстановления отправлено.' }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/password/reset') {
      const token = String(input.token || ''); const password = String(input.password || '');
      if (password.length < 1 || password.length > 128) fail('Пароль должен содержать от 1 до 128 символов');
      const key = crypto.createHash('sha256').update(token).digest('hex'); const reset = passwordResets[key];
      if (!reset || reset.expiresAt < Date.now() || !accounts[reset.accountId]) fail('Ссылка недействительна или срок её действия истёк', 400);
      const account = accounts[reset.accountId]; const salt = crypto.randomBytes(16).toString('hex');
      account.salt = salt; account.passwordHash = passwordHash(password, salt);
      for (const [resetKey, item] of Object.entries(passwordResets)) if (item.accountId === account.id) delete passwordResets[resetKey];
      savePasswordResets(); saveAccounts();
      for (const [sessionHash, accountId] of Object.entries(sessions)) if (accountId === account.id) delete sessions[sessionHash];
      saveSessions(); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/me') { const account = currentAccount(req); send(res, 200, { account: safeAccount(account) }); return; }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      currentAccount(req);
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const key = crypto.createHash('sha256').update(token).digest('hex'); delete sessions[key]; saveSessions(); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && route[0] === 'api' && route[1] === 'room') { const account = currentAccount(req); const room = roomFor(route[2]); const viewer = room.players.find((p) => p.id === url.searchParams.get('player')); if (!viewer || viewer.accountId !== account.id || viewer.kicked) fail('Нет доступа к комнате', 403); refreshPresence(room, viewer.id); send(res, 200, publicRoom(room, viewer.id, account.id)); return; }
    if (req.method === 'GET' && url.pathname === '/api/admin/rooms') {
      const admin = requireAdmin(req);
      for (const room of Object.values(rooms)) refreshPresence(room);
      const result = Object.values(rooms).map((room) => ({ code: room.code, phase: room.phase, day: room.day, deadline: room.deadline || null, lobbyTimerKind: room.lobbyTimerKind || null,
        players: room.players.map((p) => ({ id: p.id, accountId: p.accountId, name: p.name, bot: Boolean(p.bot), personality: p.bot ? p.personality || 'neutral' : undefined, connected: p.connected, alive: p.alive, isBanned: Boolean(bans[p.accountId]) })),
        chat: (room.chat || []).slice(-60), winner: room.winner || null, testSpecialRoles: Boolean(room.testSpecialRoles), testRoleReveal: Boolean(room.testRoleReveal) }));
      send(res, 200, { rooms: result, bans: Object.entries(bans).map(([accountId, ban]) => ({ accountId, ...ban })), audit: adminLog.slice(-100), settings: publicSettings() }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/smtp') {
      const admin = requireAdmin(req); const { host, port, encryption, username, password, from } = input;
      if (typeof host !== 'string' || host.length > 253 || (host && !/^[a-z\d.-]+$/i.test(host))) fail('Проверьте имя SMTP-сервера');
      if (!Number.isInteger(port) || port < 1 || port > 65_535) fail('Порт SMTP должен быть от 1 до 65535');
      if (!['none', 'ssl', 'starttls'].includes(encryption)) fail('Выберите тип шифрования SMTP');
      if (typeof username !== 'string' || username.length > 254 || typeof password !== 'string' || password.length > 512) fail('Проверьте логин и пароль SMTP');
      if (typeof from !== 'string' || from.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) fail('Укажите корректный адрес отправителя');
      gameSettings.smtp = { host: host.trim(), port, encryption, username: username.trim(), password: password || gameSettings.smtp.password || '', from: from.trim() };
      saveGameSettings(); logAdmin(admin, 'smtp-settings', { host: gameSettings.smtp.host, port, encryption, from: gameSettings.smtp.from });
      send(res, 200, { settings: publicSettings() }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/smtp-test') {
      const admin = requireAdmin(req); const recipient = String(input.email || '').trim().toLowerCase();
      if (!smtpSettingsReady()) fail('Сначала сохраните настройки SMTP');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) fail('Укажите адрес для тестового письма');
      await smtpSend(gameSettings.smtp, recipient, 'Проверка почты Mafia', 'Настройки SMTP работают.');
      logAdmin(admin, 'smtp-test', { recipient }); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/settings') {
      const admin = requireAdmin(req);
      const previous = { autoFillBots: gameSettings.autoFillBots, humanWaitSeconds: gameSettings.humanWaitSeconds, startDelaySeconds: gameSettings.startDelaySeconds };
      const hasBotPool = Array.isArray(input.botPersonalityPool);
      const hasLobbySettings = ['autoFillBots', 'humanWaitSeconds', 'startDelaySeconds'].some((key) => Object.hasOwn(input, key));
      const hasBonusSettings = ['bonusesEnabled', 'bonusIntervalSeconds'].some((key) => Object.hasOwn(input, key));
      const hasTestSettings = Object.hasOwn(input, 'roleRevealTestRooms');
      const hasDeathRevealSettings = ['mafiaKillRoleVisibility', 'townVoteRoleVisibility'].some((key) => Object.hasOwn(input, key));
      if (typeof input.teasingHumor !== 'boolean' && !hasBotPool && !hasLobbySettings && !hasBonusSettings && !hasTestSettings && !hasDeathRevealSettings) fail('Передайте одну из настроек игры');
      if (hasBotPool && input.botPersonalityPool.some((personality) => !BOT_PERSONALITIES.includes(personality))) fail('Неизвестный характер бота');
      if (Object.hasOwn(input, 'autoFillBots') && typeof input.autoFillBots !== 'boolean') fail('Автодобор ботами должен быть включён или выключен');
      if (Object.hasOwn(input, 'humanWaitSeconds') && (!Number.isInteger(input.humanWaitSeconds) || input.humanWaitSeconds < 1 || input.humanWaitSeconds > 86_400)) fail('Ожидание людей должно быть от 1 до 86400 секунд');
      if (Object.hasOwn(input, 'startDelaySeconds') && (!Number.isInteger(input.startDelaySeconds) || input.startDelaySeconds < 0 || input.startDelaySeconds > 86_400)) fail('Отсчёт до старта должен быть от 0 до 86400 секунд');
      if (Object.hasOwn(input, 'bonusesEnabled') && typeof input.bonusesEnabled !== 'boolean') fail('Выдача бонусов должна быть включена или выключена');
      if (Object.hasOwn(input, 'bonusIntervalSeconds') && (!Number.isInteger(input.bonusIntervalSeconds) || input.bonusIntervalSeconds < 3_600 || input.bonusIntervalSeconds > 31_536_000)) fail('Интервал бонусов должен быть от часа до года');
      if (Object.hasOwn(input, 'roleRevealTestRooms') && typeof input.roleRevealTestRooms !== 'boolean') fail('Настройка раскрытия ролей должна быть включена или выключена');
      if (Object.hasOwn(input, 'mafiaKillRoleVisibility') && !['team', 'killer', 'none'].includes(input.mafiaKillRoleVisibility)) fail('Выберите, кто видит роль цели мафии');
      if (Object.hasOwn(input, 'townVoteRoleVisibility') && !['team', 'none'].includes(input.townVoteRoleVisibility)) fail('Выберите, кому раскрывать роль исключённого игрока');
      const lobbySettingsChanged = hasLobbySettings;
      if (typeof input.teasingHumor === 'boolean') gameSettings.teasingHumor = input.teasingHumor;
      if (Array.isArray(input.botPersonalityPool)) {
        gameSettings.botPersonalityPool = [...new Set(input.botPersonalityPool)];
      }
      if (Object.hasOwn(input, 'autoFillBots')) {
        gameSettings.autoFillBots = input.autoFillBots;
      }
      if (Object.hasOwn(input, 'humanWaitSeconds')) {
        gameSettings.humanWaitSeconds = input.humanWaitSeconds;
      }
      if (Object.hasOwn(input, 'startDelaySeconds')) {
        gameSettings.startDelaySeconds = input.startDelaySeconds;
      }
      if (Object.hasOwn(input, 'bonusesEnabled')) gameSettings.bonusesEnabled = input.bonusesEnabled;
      if (Object.hasOwn(input, 'bonusIntervalSeconds')) gameSettings.bonusIntervalSeconds = input.bonusIntervalSeconds;
      if (Object.hasOwn(input, 'roleRevealTestRooms')) gameSettings.roleRevealTestRooms = input.roleRevealTestRooms;
      if (Object.hasOwn(input, 'mafiaKillRoleVisibility')) gameSettings.mafiaKillRoleVisibility = input.mafiaKillRoleVisibility;
      if (Object.hasOwn(input, 'townVoteRoleVisibility')) gameSettings.townVoteRoleVisibility = input.townVoteRoleVisibility;
      saveGameSettings();
      if (lobbySettingsChanged) refreshLobbyTimers(previous);
      logAdmin(admin, 'settings', { teasingHumor: gameSettings.teasingHumor, botPersonalityPool: gameSettings.botPersonalityPool, autoFillBots: gameSettings.autoFillBots, humanWaitSeconds: gameSettings.humanWaitSeconds, startDelaySeconds: gameSettings.startDelaySeconds, bonusesEnabled: gameSettings.bonusesEnabled, bonusIntervalSeconds: gameSettings.bonusIntervalSeconds, roleRevealTestRooms: gameSettings.roleRevealTestRooms, mafiaKillRoleVisibility: gameSettings.mafiaKillRoleVisibility, townVoteRoleVisibility: gameSettings.townVoteRoleVisibility });
      send(res, 200, { settings: publicSettings() }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/test-fill') {
      const admin = requireAdmin(req); const room = roomFor(input.code);
      if (room.phase !== 'lobby') fail('Тестовых игроков можно добавить только до начала игры');
      if (!room.players.some((player) => player.accountId === admin.id && !player.kicked)) fail('Сначала войдите в эту комнату как игрок', 403);
      const targetCount = Number(input.count || RULES.minPlayers);
      if (!Number.isInteger(targetCount) || targetCount < RULES.minPlayers || targetCount > RULES.maxPlayers) fail(`Количество игроков должно быть от ${RULES.minPlayers} до ${RULES.maxPlayers}`);
      const addCount = Math.min(targetCount, RULES.maxPlayers) - room.players.length;
      if (addCount < 0) fail('В комнате уже больше игроков, чем указано');
      fillBotSeats(room, targetCount); syncLobbyTimer(room);
      logAdmin(admin, 'test-fill', { code: room.code, added: addCount }); saveRooms();
      send(res, 200, { room: publicRoom(room, room.players.find((player) => player.accountId === admin.id).id, admin.id), added: addCount }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/test-room-settings') {
      const admin = requireAdmin(req); const room = roomFor(input.code);
      if (room.phase !== 'lobby') fail('Настройки тестовой партии можно менять только до старта');
      if (!room.players.some((player) => player.accountId === admin.id && !player.kicked)) fail('Сначала войдите в эту комнату как игрок', 403);
      if (typeof input.specialRoles !== 'boolean' || typeof input.revealEliminatedRoles !== 'boolean') fail('Укажите переключатели тестовых ролей и раскрытия');
      if (input.revealEliminatedRoles && !gameSettings.roleRevealTestRooms) fail('Сначала включите раскрытие ролей тестовых комнат в общих настройках админки');
      room.testSpecialRoles = input.specialRoles; room.testRoleReveal = input.revealEliminatedRoles;
      saveRooms(); logAdmin(admin, 'test-room-settings', { code: room.code, ...input });
      send(res, 200, { ok: true, testSpecialRoles: room.testSpecialRoles, testRoleReveal: room.testRoleReveal, phase: room.phase, players: room.players.length }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/accounts') {
      requireAdmin(req);
      send(res, 200, { accounts: Object.values(accounts).map((account) => ({ ...safeAccount(account), createdAt: account.createdAt, banned: Boolean(bans[account.id]) })) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/moderate') {
      const admin = requireAdmin(req); const room = roomFor(input.code); const player = playerFor(room, input.playerId);
      const action = input.action; const reason = String(input.reason || '').trim().slice(0, 240);
      if (action !== 'kick' && action !== 'ban') fail('Неизвестное действие модерации');
      if (player.accountId === admin.id) fail('Нельзя модерировать собственный аккаунт');
      if (action === 'ban' && !player.accountId) fail('Нельзя забанить старого игрока без аккаунта');
      removePlayerFromRoom(room, player, true);
      if (action === 'ban') {
        bans[player.accountId] = { username: accounts[player.accountId]?.username || player.name, reason, at: Date.now(), by: admin.id };
        for (const [tokenHash, accountId] of Object.entries(sessions)) if (accountId === player.accountId) delete sessions[tokenHash];
        saveBans(); saveSessions();
        for (const otherRoom of Object.values(rooms)) {
          if (otherRoom === room || otherRoom.phase === 'ended') continue;
          const match = otherRoom.players.find((p) => p.accountId === player.accountId);
          if (match) removePlayerFromRoom(otherRoom, match, true);
        }
      }
      logAdmin(admin, action, { code: room.code, playerId: player.id, accountId: player.accountId || null, player: player.name, reason });
      saveRooms(); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/unban') {
      const admin = requireAdmin(req); const accountId = String(input.accountId || ''); const ban = bans[accountId]; if (!ban) fail('Блокировка не найдена', 404);
      delete bans[accountId]; saveBans(); logAdmin(admin, 'unban', { accountId, username: ban.username }); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/reset-password') {
      const admin = requireAdmin(req); const account = accounts[String(input.accountId || '')];
      if (!account) fail('Аккаунт не найден', 404); if (account.id === admin.id) fail('Нельзя сбросить пароль текущего администратора');
      const temporaryPassword = crypto.randomBytes(12).toString('base64url'); const salt = crypto.randomBytes(16).toString('hex');
      account.salt = salt; account.passwordHash = passwordHash(temporaryPassword, salt); saveAccounts();
      for (const [tokenHash, accountId] of Object.entries(sessions)) if (accountId === account.id) delete sessions[tokenHash];
      saveSessions(); logAdmin(admin, 'reset-password', { accountId: account.id, username: account.username });
      send(res, 200, { temporaryPassword }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/account-levels') {
      const admin = requireAdmin(req); const account = accounts[String(input.accountId || '')];
      if (!account) fail('Аккаунт не найден', 404);
      const peacefulLevel = Number(input.peacefulLevel); const mafiaLevel = Number(input.mafiaLevel);
      if (!Number.isInteger(peacefulLevel) || peacefulLevel < 0 || peacefulLevel > 100 || !Number.isInteger(mafiaLevel) || mafiaLevel < 0 || mafiaLevel > 100) fail('Уровни должны быть целыми числами от 0 до 100');
      const previous = { peacefulLevel: account.peacefulLevel, mafiaLevel: account.mafiaLevel };
      account.peacefulLevel = peacefulLevel; account.mafiaLevel = mafiaLevel; saveAccounts();
      logAdmin(admin, 'account-levels', { accountId: account.id, username: account.username, previous, peacefulLevel, mafiaLevel });
      send(res, 200, { account: safeAccount(account) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/account-visibility') {
      const admin = requireAdmin(req); const account = accounts[String(input.accountId || '')];
      if (!account) fail('Аккаунт не найден', 404);
      if (typeof input.hidePeacefulLevel !== 'boolean' || typeof input.hideMafiaLevel !== 'boolean') fail('Настройки скрытия должны быть включены или выключены');
      account.hidePeacefulLevel = input.hidePeacefulLevel; account.hideMafiaLevel = input.hideMafiaLevel; saveAccounts();
      logAdmin(admin, 'account-visibility', { accountId: account.id, username: account.username, hidePeacefulLevel: account.hidePeacefulLevel, hideMafiaLevel: account.hideMafiaLevel });
      send(res, 200, { account: safeAccount(account) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/delete-account') {
      const admin = requireAdmin(req); const account = accounts[String(input.accountId || '')];
      if (!account) fail('Аккаунт не найден', 404);
      if (account.id === admin.id || account.isAdmin) fail('Нельзя удалить аккаунт администратора');
      for (const room of Object.values(rooms)) {
        if (room.phase === 'ended') continue;
        const player = room.players.find((entry) => entry.accountId === account.id && !entry.kicked);
        if (player) removePlayerFromRoom(room, player, true);
      }
      delete accounts[account.id]; delete bans[account.id];
      for (const [tokenHash, accountId] of Object.entries(sessions)) if (accountId === account.id) delete sessions[tokenHash];
      saveAccounts(); saveBans(); saveSessions();
      logAdmin(admin, 'delete-account', { accountId: account.id, username: account.username }); saveRooms();
      send(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const account = currentAccount(req); requirePlayable(account); const name = account.username;
      const existing = activeParticipation(account.id); if (existing) fail(`Вы уже участвуете в комнате ${existing.room.code}; вернитесь в неё быстрым входом`);
      let code; do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms[code]);
      const room = roomObject(code); const id = crypto.randomUUID(); room.players.push({ id, accountId: account.id, name, alive: true, connected: true, lastSeenAt: Date.now() });
      announce(room, `${name} открыл комнату. Системный ведущий ждёт участников.`); rooms[code] = room; syncLobbyTimer(room); saveRooms();
      send(res, 201, { room: publicRoom(room, id, account.id), playerId: id }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auto-join') {
      const account = currentAccount(req); requirePlayable(account); const name = account.username;
      const existing = activeParticipation(account.id);
      if (existing) { refreshPresence(existing.room, existing.player.id); send(res, 200, { room: publicRoom(existing.room, existing.player.id, account.id), playerId: existing.player.id }); return; }
      let room = Object.values(rooms).find((r) => r.phase === 'lobby' && r.players.length < RULES.maxPlayers && !r.players.some((p) => p.name.toLowerCase() === name.toLowerCase()));
      if (!room) { let code; do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms[code]); room = roomObject(code); rooms[code] = room; announce(room, 'Открыта новая комната. Системный ведущий ждёт участников.'); }
      const id = crypto.randomUUID(); room.players.push({ id, accountId: account.id, name, alive: true, connected: true, lastSeenAt: Date.now() }); announce(room, `${name} присоединился к игре.`);
      syncLobbyTimer(room);
      saveRooms(); send(res, 201, { room: publicRoom(room, id, account.id), playerId: id }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const account = currentAccount(req); requirePlayable(account); const room = roomFor(input.code); const name = account.username;
      const existing = activeParticipation(account.id);
      if (existing) {
        if (existing.room.code !== room.code) fail(`Вы уже участвуете в комнате ${existing.room.code}; сначала вернитесь в неё или выйдите из игры`);
        refreshPresence(existing.room, existing.player.id); send(res, 200, { room: publicRoom(existing.room, existing.player.id, account.id), playerId: existing.player.id }); return;
      }
      if (room.phase !== 'lobby') fail('Игра уже началась'); if (room.players.length >= RULES.maxPlayers) fail('Комната заполнена');
      if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail('Это имя уже занято в комнате');
      const id = crypto.randomUUID(); room.players.push({ id, accountId: account.id, name, alive: true, connected: true, lastSeenAt: Date.now() }); announce(room, `${name} присоединился к игре.`);
      syncLobbyTimer(room);
      saveRooms(); send(res, 201, { room: publicRoom(room, id, account.id), playerId: id }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/team-choice') {
      const account = currentAccount(req); const room = roomFor(input.code); const actor = playerFor(room, input.playerId);
      if (actor.accountId !== account.id) fail('Нет доступа к игроку', 403);
      if (room.phase !== 'lobby') fail('Команду можно выбрать только до начала игры');
      const eligible = [Number(account.peacefulLevel) >= 100 ? 'town' : null, Number(account.mafiaLevel) >= 100 ? 'mafia' : null].filter(Boolean);
      if (!eligible.includes(input.team)) fail('Выбор команды открывается при 100-м уровне соответствующей шкалы');
      room.teamChoices ||= {}; room.teamChoices[account.id] = input.team;
      saveRooms(); send(res, 200, publicRoom(room, actor.id, account.id)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/bonus/use') {
      const account = currentAccount(req); requirePlayable(account); const room = roomFor(input.code); const actor = playerFor(room, input.playerId);
      if (actor.accountId !== account.id) fail('Нет доступа к игроку', 403);
      if (!actor.alive) fail('Выбывший игрок не может использовать бонус');
      const bonus = (account.bonuses || []).find((item) => item.id === input.bonusId && !item.usedAt);
      if (!bonus) fail('Бонус уже использован или не найден');
      const effect = bonus.effect || bonusEffect(bonus.threshold);
      if (!BONUS_EFFECTS[effect]) fail('Неизвестный эффект бонуса');
      if (effect === 'discussion_time') {
        if (room.phase !== 'discussion') fail('Дополнительное время можно использовать во время свободного обсуждения');
        room.deadline = (room.deadline || Date.now()) + 30_000;
        armTimer(room, room.deadline - Date.now(), () => startSpeeches(room));
        announce(room, `${actor.name} добавил городу 30 секунд на обсуждение.`);
      } else if (effect === 'weighted_vote') {
        if (room.phase !== 'voting' && room.phase !== 'revote') fail('Двойной голос можно использовать только во время голосования');
        (room.doubleVotes ||= {})[actor.id] = true;
        announce(room, `${actor.name} использовал бонус на решающий голос.`);
      } else if (effect === 'check_shield') {
        if (room.phase !== 'night') fail('Щит от проверки можно включить только ночью');
        room.night.shields ||= {}; room.night.shields[actor.id] = true;
        announce(room, 'Кто-то активировал защиту от проверки. Ведущий ничего не подсказывает.');
      }
      bonus.usedAt = Date.now(); bonus.usedInRoom = room.code; saveAccounts(); saveRooms();
      send(res, 200, publicRoom(room, actor.id, account.id)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const account = currentAccount(req); requirePlayable(account); const room = roomFor(input.code); const actor = playerFor(room, input.playerId); if (actor.accountId !== account.id) fail('Нет доступа к игроку', 403); const targetId = input.targetId;
      if (!actor.alive) fail('Вы выбыли и больше не можете действовать');
      if (input.action === 'mafia') {
        if (room.phase !== 'night' || !isMafia(actor) || actor.role === 'don') fail('Сейчас нельзя голосовать за ночную цель');
        const target = playerFor(room, targetId); if (!target.alive || isMafia(target)) fail('Выберите живого игрока из другой команды');
        room.night.votes[actor.id] = target.id;
        if (nightReady(room)) finishNight(room);
      } else if (input.action === 'investigate') {
        if (room.phase !== 'night' || !['detective', 'don'].includes(actor.role)) fail('Сейчас проверка недоступна');
        const target = playerFor(room, targetId); if (!target.alive || target.id === actor.id) fail('Выберите другого живого игрока');
        const shielded = Boolean(room.night.shields?.[target.id]);
        if (shielded) delete room.night.shields[target.id];
        room.night.checks[actor.id] = { targetId: target.id, isMafia: shielded ? null : (actor.role === 'don' ? target.role === 'detective' : isMafia(target)), targetRole: actor.role === 'detective' && !shielded ? target.role : null, blocked: shielded };
        if (nightReady(room)) finishNight(room);
      } else if (input.action === 'protect') {
        if (room.phase !== 'night' || actor.role !== 'doctor') fail('Сейчас защита недоступна');
        const target = playerFor(room, targetId);
        if (!doctorCanProtect(actor, target)) fail('Доктор не может лечить себя, мёртвого игрока или одну цель две ночи подряд');
        room.night.protections[actor.id] = target.id;
        if (nightReady(room)) finishNight(room);
      } else if (input.action === 'vote') {
        if (room.phase !== 'voting' && room.phase !== 'revote') fail('Сейчас голосование закрыто');
        const target = playerFor(room, targetId); if (!target.alive || target.id === actor.id || (room.phase === 'revote' && !room.candidates.includes(target.id))) fail('Нельзя проголосовать за этого игрока');
        room.votes[actor.id] = target.id;
        if (actor.role === 'mayor' && actor.mayorRevealed) (room.doubleVotes ||= {})[actor.id] = true;
        if (live(room).every((p) => room.votes[p.id])) finishVote(room);
      } else if (input.action === 'reveal-mayor') {
        if ((room.phase !== 'voting' && room.phase !== 'revote') || actor.role !== 'mayor') fail('Мэр может объявить роль только во время голосования');
        if (actor.mayorRevealed) fail('Вы уже объявили себя мэром');
        actor.mayorRevealed = true; (room.nextDoubleVotes ||= {})[actor.id] = true; announce(room, `${actor.name} объявил себя мэром. Его голос станет двойным со следующего голосования.`);
      } else if (input.action === 'speak') {
        if (room.phase !== 'speeches' || room.speakerOrder[room.speakerIndex] !== actor.id) fail('Сейчас очередь другого игрока');
        room.spoken ||= []; room.spoken.push(actor.id); room.speakerIndex++; nextSpeaker(room);
      } else if (input.action === 'speech') {
        if (room.phase !== 'speeches' || room.speakerOrder[room.speakerIndex] !== actor.id) fail('Сейчас очередь другого игрока');
        const message = String(input.message || '').trim().slice(0, 1000); if (!message) fail('Введите выступление');
        room.chat.push({ playerId: actor.id, name: actor.name, text: message, at: Date.now(), speech: true }); room.chat = room.chat.slice(-200); room.spoken ||= []; room.spoken.push(actor.id);
        room.speakerIndex++; nextSpeaker(room);
      } else if (input.action === 'chat') {
        if (room.phase !== 'discussion') fail('Чат открыт только во время свободного обсуждения');
        const message = String(input.message || '').trim().slice(0, 500); if (!message) fail('Пустое сообщение');
        room.chat.push({ playerId: actor.id, name: actor.name, text: message, at: Date.now() }); room.chat = room.chat.slice(-200);
        scheduleBotChat(room);
      } else fail('Неизвестное действие');
      saveRooms(); send(res, 200, publicRoom(room, actor.id, account.id)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/leave') {
      const account = currentAccount(req); const room = roomFor(input.code); const player = playerFor(room, input.playerId); if (player.accountId !== account.id) fail('Нет доступа к игроку', 403);
      removePlayerFromRoom(room, player);
      saveRooms(); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') { send(res, 200, { ok: true, rooms: Object.keys(rooms).length }); return; }
    send(res, 404, { error: 'Маршрут не найден' });
  } catch (error) { send(res, error.status || 500, { error: error.message || 'Ошибка сервера' }); }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) { api(req, res, url); return; }
  let relative; try { relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { res.writeHead(400); res.end('Bad request'); return; }
  const root = path.resolve(ROOT, 'public'); const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (error, data) => { if (error) { res.writeHead(404); res.end('Not found'); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data); });
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Если Mafia уже открывается по адресу http://localhost:${PORT}, используйте это окно браузера. Иначе остановите программу, занявшую порт, или задайте другой порт через переменную PORT.`);
    process.exitCode = 1;
    return;
  }
  console.error(`Не удалось запустить сервер: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, '0.0.0.0', () => {
  const port = server.address().port;
  if (PID_FILE) fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port }));
  console.log(`Mafia MVP: http://localhost:${port} (другие устройства этой сети: http://<IP-этого-компьютера>:${port})`);
});
if (PID_FILE) process.on('exit', () => {
  try {
    if (JSON.parse(fs.readFileSync(PID_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch { /* stop.bat also removes stale markers after a forced shutdown. */ }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.closeAllConnections?.();
  try { store.db.close(); } catch { /* The database may already be closed during shutdown. */ }
  process.exit(0);
});
