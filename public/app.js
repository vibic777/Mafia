const $ = (selector) => document.querySelector(selector);
const state = { mode: 'auto', authMode: 'login', needsSetup: false, code: null, playerId: null, room: null, busy: false, polling: null, clock: null, token: null, account: null };
const roles = { mafia: ['Мафия', 'Ночью молча выбирайте цель вместе с командой.'], don: ['Дон', 'Вы входите в мафию. Ночью проверьте одного игрока: узнайте, комиссар ли он. Вы не голосуете за жертву.'], detective: ['Комиссар', 'Ночью проверяйте игрока. Результат проверки виден только вам.'], doctor: ['Доктор', 'Ночью защитите одного другого игрока. Нельзя лечить себя или одну цель две ночи подряд.'], mayor: ['Мэр', 'Откройте роль во время голосования: ваш голос станет двойным со следующего голосования.'], villager: ['Мирный житель', 'Обсуждайте подозрения и помогите городу вычислить мафию.'] };
const roleMarks = { mafia: '♠', don: '♛', mayor: '⚖', detective: '⌕', doctor: '✚', villager: '✦' };
const botPersonalities = { neutral: 'обычный', friendly: 'добрый', jokester: 'шутник', sharp: 'резкий', chaotic: 'хаотичный', gentle: 'мягкий' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
$('#help-open').addEventListener('click', () => $('#help-dialog').showModal());
$('#help-close').addEventListener('click', () => $('#help-dialog').close());
$('#help-dialog').addEventListener('click', (event) => { if (event.target === $('#help-dialog')) $('#help-dialog').close(); });
async function request(url, data) {
  const headers = data ? { 'Content-Type': 'application/json' } : {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(url, { method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || 'Ошибка запроса'); return result;
}
function showGame() { $('#home').classList.add('hidden'); $('#game').classList.remove('hidden'); }
function showHome() { $('#game').classList.add('hidden'); $('#home').classList.remove('hidden'); }
function setEntryError(message = '') { $('#entry-error').textContent = message; }
function setAuthenticated(account, token) {
  state.account = account; state.token = token; localStorage.setItem('mafia-auth', JSON.stringify({ token }));
  $('#auth-panel').classList.add('hidden'); $('#room-entry').classList.remove('hidden');
  $('#account-name').textContent = account.username; $('#player-name').value = account.username;
  $('#account-levels').textContent = `МИРНЫЙ ${account.peacefulLevel}/100 · МАФИЯ ${account.mafiaLevel}/100`;
  const bonusPanel = $('#account-bonuses');
  if (bonusPanel) bonusPanel.textContent = `БОНУСЫ: ${account.bonuses?.filter((bonus) => !bonus.usedAt).length || 0} · ${account.nextBonusAt ? `следующий после ${new Date(account.nextBonusAt).toLocaleDateString('ru-RU')}` : 'ожидают доступного уровня'}`;
  $('#admin-open').classList.toggle('hidden', !account.isAdmin);
  $('#game-admin-open').classList.toggle('hidden', !account.isAdmin);
}
function setAuthMode(mode) {
  state.authMode = mode; document.querySelectorAll('.auth-tab').forEach((item) => item.classList.toggle('active', item.dataset.authMode === mode));
  const registering = mode === 'register' || mode === 'setup';
  $('#auth-submit span:first-child').textContent = mode === 'setup' ? 'Создать администратора' : registering ? 'Создать аккаунт' : 'Войти';
  $('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-email-wrap').classList.toggle('hidden', !registering); $('#auth-email').required = mode === 'setup';
  $('#forgot-open').classList.toggle('hidden', registering || mode === 'setup');
  $('#auth-error').textContent = '';
}
document.querySelectorAll('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#auth-submit'); button.disabled = true; $('#auth-error').textContent = '';
  const values = new FormData(event.currentTarget); const payload = { username: values.get('username'), password: values.get('password'), email: values.get('email') };
  try { const result = await request(state.authMode === 'login' ? '/api/login' : '/api/register', payload); setAuthenticated(result.account, result.token); history.replaceState(null, '', '/'); }
  catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#forgot-open').addEventListener('click', () => { $('#auth-form').classList.add('hidden'); $('#auth-tabs').classList.add('hidden'); $('#forgot-open').classList.add('hidden'); $('#forgot-form').classList.remove('hidden'); $('#forgot-message').textContent = ''; });
$('#forgot-back').addEventListener('click', () => { $('#forgot-form').classList.add('hidden'); $('#auth-form').classList.remove('hidden'); $('#auth-tabs').classList.toggle('hidden', state.needsSetup); $('#forgot-open').classList.toggle('hidden', state.authMode !== 'login'); });
$('#forgot-form').addEventListener('submit', async (event) => { event.preventDefault(); const message = $('#forgot-message'); message.textContent = 'Отправляем…'; try { const result = await request('/api/password/forgot', { email: $('#forgot-email').value }); message.textContent = result.message; } catch (error) { message.textContent = error.message; } });
$('#reset-form').addEventListener('submit', async (event) => { event.preventDefault(); const message = $('#reset-message'); try { await request('/api/password/reset', { token: new URLSearchParams(location.search).get('reset'), password: $('#reset-password').value }); message.textContent = 'Пароль изменён. Теперь войдите с новым паролем.'; history.replaceState(null, '', '/'); $('#reset-form').classList.add('hidden'); $('#auth-form').classList.remove('hidden'); } catch (error) { message.textContent = error.message; } });
$('#save-smtp').addEventListener('click', async () => {
  const status = $('#smtp-status'); const button = $('#save-smtp'); button.disabled = true; status.textContent = '';
  try {
    const result = await request('/api/admin/smtp', { host: $('#smtp-host').value.trim(), port: Number($('#smtp-port').value), encryption: $('#smtp-encryption').value, username: $('#smtp-username').value, password: $('#smtp-password').value, from: $('#smtp-from').value.trim() });
    $('#smtp-password').value = ''; status.textContent = result.settings.smtp.passwordConfigured ? 'Настройки сохранены. Пароль SMTP сохранён.' : 'Настройки сохранены.';
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
$('#test-smtp').addEventListener('click', async () => { const status = $('#smtp-status'); try { await request('/api/admin/smtp-test', { email: $('#smtp-test-email').value }); status.textContent = 'Пробное письмо отправлено.'; } catch (error) { status.textContent = error.message; } });
$('#logout').addEventListener('click', async () => {
  try { await request('/api/logout', {}); } catch {}
  clearInterval(state.polling); clearInterval(state.clock); state.token = null; state.account = null; state.code = null; state.playerId = null; state.room = null;
  localStorage.removeItem('mafia-auth'); localStorage.removeItem('mafia-player'); $('#room-entry').classList.add('hidden'); $('#auth-panel').classList.remove('hidden'); showHome();
});
$('#admin-open').addEventListener('click', () => { $('#room-entry').classList.add('hidden'); $('#admin-panel').classList.remove('hidden'); loadAdmin(); });
$('#game-admin-open').addEventListener('click', () => { showHome(); $('#room-entry').classList.add('hidden'); $('#admin-panel').classList.remove('hidden'); loadAdmin(); });
$('#admin-back').addEventListener('click', () => {
  $('#admin-panel').classList.add('hidden');
  if (state.code) showGame(); else { $('#room-entry').classList.remove('hidden'); showHome(); }
});
$('#admin-refresh').addEventListener('click', loadAdmin);
$('#save-lobby-settings').addEventListener('click', async () => {
  const humanWait = $('#human-wait-seconds'); const startDelay = $('#start-delay-seconds');
  if (!humanWait.reportValidity() || !startDelay.reportValidity()) return;
  const button = $('#save-lobby-settings'); button.disabled = true;
  try {
    await request('/api/admin/settings', { autoFillBots: $('#auto-fill-bots').checked, humanWaitSeconds: Number(humanWait.value), startDelaySeconds: Number(startDelay.value) });
    await loadAdmin();
  } catch (error) { $('#admin-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#save-role-reveal').addEventListener('click', async () => {
  const control = $('#role-reveal-test-rooms'); control.disabled = true;
  try { await request('/api/admin/settings', { roleRevealTestRooms: control.checked }); await loadAdmin(); }
  catch (error) { $('#admin-error').textContent = error.message; await loadAdmin(); }
  finally { control.disabled = false; }
});
$('#save-death-role-visibility').addEventListener('click', async () => {
  const button = $('#save-death-role-visibility'); button.disabled = true;
  try {
    await request('/api/admin/settings', { mafiaKillRoleVisibility: $('#mafia-kill-role-visibility').value, townVoteRoleVisibility: $('#town-vote-role-visibility').value });
    $('#admin-error').textContent = 'Правила показа ролей сохранены.';
  } catch (error) { $('#admin-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#save-bonus-settings').addEventListener('click', async () => {
  const enabled = $('#bonuses-enabled'); const interval = $('#bonus-interval-seconds');
  if (!interval.reportValidity()) return;
  try { await request('/api/admin/settings', { bonusesEnabled: enabled.checked, bonusIntervalSeconds: Number(interval.value) }); await loadAdmin(); }
  catch (error) { $('#admin-error').textContent = error.message; }
});
$('#teasing-humor').addEventListener('change', async (event) => {
  const checkbox = event.currentTarget; checkbox.disabled = true;
  try { const result = await request('/api/admin/settings', { teasingHumor: checkbox.checked }); checkbox.checked = result.settings.teasingHumor; }
  catch (error) { checkbox.checked = !checkbox.checked; $('#admin-error').textContent = error.message; }
  finally { checkbox.disabled = false; }
});
document.querySelectorAll('[data-bot-personality]').forEach((checkbox) => checkbox.addEventListener('change', async () => {
  const boxes = [...document.querySelectorAll('[data-bot-personality]')]; boxes.forEach((box) => { box.disabled = true; });
  try {
    const botPersonalityPool = boxes.filter((box) => box.checked).map((box) => box.dataset.botPersonality);
    const result = await request('/api/admin/settings', { botPersonalityPool });
    boxes.forEach((box) => { box.checked = result.settings.botPersonalityPool.includes(box.dataset.botPersonality); });
    } catch (error) { $('#admin-error').textContent = error.message; await loadAdmin(); }
  finally { boxes.forEach((box) => { box.disabled = false; }); }
}));
async function loadAdmin() {
  $('#admin-error').textContent = '';
  try {
    const data = await request('/api/admin/rooms');
    $('#auto-fill-bots').checked = Boolean(data.settings?.autoFillBots);
    $('#human-wait-seconds').value = data.settings?.humanWaitSeconds ?? 60;
    $('#start-delay-seconds').value = data.settings?.startDelaySeconds ?? 60;
    $('#teasing-humor').checked = Boolean(data.settings?.teasingHumor);
    $('#role-reveal-test-rooms').checked = Boolean(data.settings?.roleRevealTestRooms);
    $('#mafia-kill-role-visibility').value = data.settings?.mafiaKillRoleVisibility || 'none';
    $('#town-vote-role-visibility').value = data.settings?.townVoteRoleVisibility || 'none';
    $('#bonuses-enabled').checked = Boolean(data.settings?.bonusesEnabled);
    $('#bonus-interval-seconds').value = data.settings?.bonusIntervalSeconds ?? 604800;
    const smtp = data.settings?.smtp || {};
    $('#smtp-host').value = smtp.host || ''; $('#smtp-port').value = smtp.port || 587; $('#smtp-encryption').value = smtp.encryption || 'starttls'; $('#smtp-username').value = smtp.username || ''; $('#smtp-from').value = smtp.from || ''; $('#smtp-password').placeholder = smtp.passwordConfigured ? 'Пароль задан · пустое поле его сохранит' : 'Пароль SMTP';
    $('#smtp-status').textContent = smtp.host ? `SMTP настроен: ${smtp.host}:${smtp.port} (${smtp.encryption}).` : 'SMTP пока не настроен.';
    const selectedPersonalities = data.settings?.botPersonalityPool || [];
    document.querySelectorAll('[data-bot-personality]').forEach((box) => { box.checked = selectedPersonalities.includes(box.dataset.botPersonality); });
    $('#admin-rooms').innerHTML = data.rooms.map((room) => {
      const canFill = room.phase === 'lobby' && room.players.some((player) => player.accountId === state.account.id);
      const fillButtons = canFill ? [6, 10, 20].filter((count) => count > room.players.length).map((count) => `<button class="text-btn" data-test-fill="${escapeHtml(room.code)}" data-count="${count}">ЗАПОЛНИТЬ ДО ${count}</button>`).join(' ') : '';
      const lobbyTimer = room.lobbyTimerKind === 'human-fill' ? 'ЖДЁМ ЛЮДЕЙ' : room.lobbyTimerKind === 'start' ? 'ДО СТАРТА' : '';
      const testSettings = canFill ? `<div class="bot-fill-actions"><label><input type="checkbox" data-test-special="${escapeHtml(room.code)}" ${room.testSpecialRoles ? 'checked' : ''}> Тестовые мэр и дон (от 10 игроков)</label><label><input type="checkbox" data-test-reveal="${escapeHtml(room.code)}" ${room.testRoleReveal ? 'checked' : ''} ${data.settings?.roleRevealTestRooms ? '' : 'disabled'}> Раскрывать выбывшие роли</label><button class="text-btn" data-save-test-room="${escapeHtml(room.code)}">СОХРАНИТЬ ПАРАМЕТРЫ ТЕСТОВОЙ КОМНАТЫ</button></div>` : '';
      return `<article class="admin-room"><div class="panel-heading"><b>${escapeHtml(room.code)}</b><span>${escapeHtml(room.phase.toUpperCase())} · ${room.players.length}/20${lobbyTimer ? ` · ${lobbyTimer}` : ''}${room.deadline ? ` · ${new Date(room.deadline).toLocaleTimeString('ru-RU')}` : ''}</span></div><div class="bot-fill-actions">${fillButtons}</div>${testSettings}<div class="admin-players">${room.players.map((player) => `<div class="admin-player"><span>${escapeHtml(player.name)}${player.bot ? ` · БОТ · ${escapeHtml(botPersonalities[player.personality] || 'обычный')}` : ''}${player.alive ? '' : ' · ВЫБЫЛ'}${player.connected ? '' : ' · НЕ В СЕТИ'}${player.isBanned ? ' · БАН' : ''}</span><span>${room.phase === 'ended' || player.accountId === state.account.id ? '' : `<button class="text-btn" data-admin-action="kick" data-code="${escapeHtml(room.code)}" data-player="${escapeHtml(player.id)}">КИК</button> <button class="text-btn" data-admin-action="ban" data-code="${escapeHtml(room.code)}" data-player="${escapeHtml(player.id)}">БАН</button>`}</span></div>`).join('')}</div><div class="admin-chat">${room.chat.map((m) => `<div><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}</div>`).join('')}</div></article>`;
    }).join('') || '<p class="hint">Открытых и сохранённых комнат нет.</p>';
    document.querySelectorAll('[data-test-fill]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try { await request('/api/admin/test-fill', { code: button.dataset.testFill, count: Number(button.dataset.count) }); await loadAdmin(); }
      catch (error) { $('#admin-error').textContent = error.message; button.disabled = false; }
    }));
    document.querySelectorAll('[data-save-test-room]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const code = button.dataset.saveTestRoom;
        await request('/api/admin/test-room-settings', { code, specialRoles: document.querySelector(`[data-test-special="${code}"]`).checked, revealEliminatedRoles: document.querySelector(`[data-test-reveal="${code}"]`).checked });
        await loadAdmin();
      } catch (error) { $('#admin-error').textContent = error.message; button.disabled = false; }
    }));
    const accountData = await request('/api/admin/accounts');
    $('#admin-accounts').innerHTML = accountData.accounts.map((account) => `<div class="admin-account admin-player"><b>${escapeHtml(account.username)}${account.isAdmin ? ' · АДМИН' : ''}${account.banned ? ' · БАН' : ''}</b><div class="admin-account-levels"><label>МИРНЫЙ <input type="number" min="0" max="100" step="1" value="${account.peacefulLevel}" data-level="peacefulLevel"></label><label>МАФИЯ <input type="number" min="0" max="100" step="1" value="${account.mafiaLevel}" data-level="mafiaLevel"></label><button class="text-btn" data-save-levels="${escapeHtml(account.id)}">УРОВНИ</button></div><div class="admin-account-visibility"><label><input type="checkbox" data-hide-level="hidePeacefulLevel" ${account.hidePeacefulLevel ? 'checked' : ''}> Скрыть мирный уровень</label><label><input type="checkbox" data-hide-level="hideMafiaLevel" ${account.hideMafiaLevel ? 'checked' : ''}> Скрыть уровень мафии</label><button class="text-btn" data-save-visibility="${escapeHtml(account.id)}">СОХРАНИТЬ ВИДИМОСТЬ</button><p class="hint">Условная донат-настройка; владелец и администратор всё равно видят уровни.</p></div>${account.id === state.account.id || account.isAdmin ? '<span class="hint">Свой аккаунт администратора изменяется обычной процедурой сброса пароля.</span>' : `<div class="admin-account-actions"><button class="text-btn" data-reset-account="${escapeHtml(account.id)}" data-name="${escapeHtml(account.username)}">СБРОСИТЬ ПАРОЛЬ</button><button class="text-btn danger-btn" data-delete-account="${escapeHtml(account.id)}" data-name="${escapeHtml(account.username)}">УДАЛИТЬ</button></div>`}</div>`).join('') || '<p class="hint">Аккаунтов нет.</p>';
    $('#admin-bans').innerHTML = data.bans.map((ban) => `<div class="admin-player"><span>${escapeHtml(ban.username)}${ban.reason ? ` · ${escapeHtml(ban.reason)}` : ''}</span><button class="text-btn" data-unban="${escapeHtml(ban.accountId)}">СНЯТЬ БАН</button></div>`).join('') || '<p class="hint">Блокировок нет.</p>';
    $('#admin-audit').innerHTML = data.audit.slice().reverse().map((item) => `<div class="admin-player"><span>${new Date(item.at).toLocaleString('ru-RU')} · ${escapeHtml(item.adminName)} · ${escapeHtml(item.action)} · ${escapeHtml(item.details.player || item.details.username || '')}</span></div>`).join('') || '<p class="hint">Действий пока нет.</p>';
    document.querySelectorAll('[data-admin-action]').forEach((button) => button.addEventListener('click', async () => {
      const action = button.dataset.adminAction; const who = button.closest('.admin-player').querySelector('span').textContent;
      if (!confirm(`${action === 'ban' ? 'Забанить' : 'Кикнуть'} ${who}?`)) return;
      const reason = action === 'ban' ? (prompt('Причина бана (необязательно):') || '') : '';
      try { await request('/api/admin/moderate', { code: button.dataset.code, playerId: button.dataset.player, action, reason }); await loadAdmin(); }
      catch (error) { $('#admin-error').textContent = error.message; }
    }));
    document.querySelectorAll('[data-unban]').forEach((button) => button.addEventListener('click', async () => { try { await request('/api/admin/unban', { accountId: button.dataset.unban }); await loadAdmin(); } catch (error) { $('#admin-error').textContent = error.message; } }));
    document.querySelectorAll('[data-reset-account]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm(`Сбросить пароль аккаунту ${button.dataset.name}?`)) return;
      try { const result = await request('/api/admin/reset-password', { accountId: button.dataset.resetAccount }); alert(`Временный пароль для ${button.dataset.name}: ${result.temporaryPassword}`); await loadAdmin(); }
      catch (error) { $('#admin-error').textContent = error.message; }
    }));
    document.querySelectorAll('[data-save-levels]').forEach((button) => button.addEventListener('click', async () => {
      const row = button.closest('.admin-account'); const values = Object.fromEntries([...row.querySelectorAll('[data-level]')].map((input) => [input.dataset.level, Number(input.value)]));
      try { await request('/api/admin/account-levels', { accountId: button.dataset.saveLevels, ...values }); await loadAdmin(); }
      catch (error) { $('#admin-error').textContent = error.message; }
    }));
    document.querySelectorAll('[data-save-visibility]').forEach((button) => button.addEventListener('click', async () => {
      const row = button.closest('.admin-account'); const values = Object.fromEntries([...row.querySelectorAll('[data-hide-level]')].map((input) => [input.dataset.hideLevel, input.checked]));
      try { await request('/api/admin/account-visibility', { accountId: button.dataset.saveVisibility, ...values }); await loadAdmin(); }
      catch (error) { $('#admin-error').textContent = error.message; }
    }));
    document.querySelectorAll('[data-delete-account]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm(`Удалить аккаунт ${button.dataset.name}? Его активные игровые сессии будут завершены.`)) return;
      try { await request('/api/admin/delete-account', { accountId: button.dataset.deleteAccount }); await loadAdmin(); }
      catch (error) { $('#admin-error').textContent = error.message; }
    }));
  } catch (error) { $('#admin-error').textContent = error.message; }
}
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.mode = tab.dataset.mode; document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  const joining = state.mode === 'join'; $('#code-wrap').classList.toggle('hidden', !joining); $('#room-code').required = joining;
  $('#entry-submit span:first-child').textContent = joining ? 'Войти по коду' : state.mode === 'create' ? 'Создать комнату' : 'Найти игру'; setEntryError('');
}));
$('#entry-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.busy) return; state.busy = true; setEntryError('');
  const name = $('#player-name').value.trim(); const button = $('#entry-submit'); button.disabled = true;
  try {
    const endpoint = state.mode === 'join' ? '/api/join' : state.mode === 'create' ? '/api/rooms' : '/api/auto-join';
    const payload = state.mode === 'join' ? { name, code: $('#room-code').value.trim().toUpperCase() } : { name };
    const result = await request(endpoint, payload);
    state.code = result.room.code; state.playerId = result.playerId; state.room = result.room;
    localStorage.setItem('mafia-player', JSON.stringify({ code: state.code, playerId: state.playerId, token: state.token }));
    showGame(); render(); startPolling();
  } catch (error) { setEntryError(error.message); }
  finally { state.busy = false; button.disabled = false; }
});
async function refresh() {
  if (!state.code || state.busy) return;
  try { state.room = await request(`/api/room/${encodeURIComponent(state.code)}?player=${encodeURIComponent(state.playerId)}`); render(); }
  catch (error) { $('#action-content').innerHTML = `<p class="action-status">${escapeHtml(error.message)}</p>`; }
}
function startPolling() { clearInterval(state.polling); state.polling = setInterval(refresh, 1100); }
async function act(action, targetId, message) {
  if (state.busy) return; state.busy = true;
  try { state.room = await request('/api/action', { code: state.code, playerId: state.playerId, action, targetId, message }); render(); }
  catch (error) { $('#action-content').insertAdjacentHTML('beforeend', `<p class="action-status">${escapeHtml(error.message)}</p>`); }
  finally { state.busy = false; }
}
async function useBonus(bonusId) {
  if (state.busy) return; state.busy = true;
  try { state.room = await request('/api/bonus/use', { code: state.code, playerId: state.playerId, bonusId }); render(); }
  catch (error) { $('#action-content').insertAdjacentHTML('beforeend', `<p class="action-status">${escapeHtml(error.message)}</p>`); }
  finally { state.busy = false; }
}
function timerMarkup(room) { return room.deadline ? `<span class="phase-timer" id="phase-timer">--:--</span>` : ''; }
function investigationHistoryMarkup(me) {
  if (me.role !== 'detective' || !me.investigationHistory?.length) return '';
  return `<section class="private-intel"><b>ЛИЧНЫЕ ПРОВЕРКИ КОМИССАРА</b>${me.investigationHistory.map((entry) => `<div>Ночь ${entry.day} · <strong>${escapeHtml(entry.targetName)}</strong>: ${entry.role ? escapeHtml(roles[entry.role]?.[0] || entry.role) : 'роль скрыта щитом'}${entry.role ? ' · карточка отмечена только у вас' : ''}</div>`).join('')}</section>`;
}
function render() {
  const room = state.room; if (!room) return;
  const focused = document.activeElement;
  const draft = focused?.form?.matches('#chat-form, #speech-form') ? { form: focused.form.id, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const me = room.you; const names = new Map(room.players.map((p) => [p.id, p.name])); clearInterval(state.clock);
  $('#room-code').textContent = room.code; $('#player-count').textContent = `${String(room.players.length).padStart(2, '0')} / ${room.maxPlayers}`;
  $('#day-label').textContent = room.phase === 'lobby' ? 'НАБОР' : `ДЕНЬ ${String(room.day).padStart(2, '0')}`;
  const phaseNames = { lobby: 'ОЖИДАНИЕ', night: 'НОЧЬ', discussion: 'ОБСУЖДЕНИЕ', speeches: 'ВЫСТУПЛЕНИЯ', voting: 'ГОЛОСОВАНИЕ', revote: 'ПЕРЕГОЛОС', ended: 'ФИНАЛ' };
  const headings = { lobby: ['ГОРОД', 'Город<br>собирается <em>вместе.</em>'], night: ['ФАЗА ИГРЫ', 'Город<br>закрывает <em>глаза.</em>'], discussion: ['ФАЗА ИГРЫ', 'Город говорит<br>пока есть <em>время.</em>'], speeches: ['ФАЗА ИГРЫ', 'Каждому —<br>своё <em>слово.</em>'], voting: ['ФАЗА ИГРЫ', 'Решает<br>голос <em>города.</em>'], revote: ['ФАЗА ИГРЫ', 'Последний<br>круг <em>голосов.</em>'], ended: ['ИГРА ОКОНЧЕНА', room.winner || 'Игра окончена.'] }[room.phase];
  $('#phase-kicker').innerHTML = `<span>${headings[0]}</span> &nbsp;/&nbsp; ${phaseNames[room.phase]} ${timerMarkup(room)}`; $('#phase-title').innerHTML = headings[1];
  $('#roster').innerHTML = room.players.map((p, index) => {
    const meta = !p.alive ? 'ВЫБЫЛ' : (!p.connected ? 'НЕ В СЕТИ' : p.id === me.id ? 'ЭТО ВЫ' : p.hasSpoken ? 'ВЫСТУПИЛ' : '');
    const knownTeam = p.team ? ` · ${p.team === 'mafia' ? 'МАФИЯ' : 'ГОРОД'}` : '';
    const role = p.role ? ` · ${roles[p.role]?.[0] || p.role}` : '';
    const roleCard = p.role ? `<span class="role-mini-card role-${escapeHtml(p.role)} ${p.alive ? '' : 'role-dead'}" title="${escapeHtml(roles[p.role]?.[0] || p.role)}${p.alive ? '' : ' · игрок выбыл'}" aria-label="${escapeHtml(roles[p.role]?.[0] || p.role)}${p.alive ? '' : ', игрок выбыл'}"><span class="role-mark">${roleMarks[p.role] || '?'}</span><span class="role-card-name">${escapeHtml(roles[p.role]?.[0] || p.role)}</span>${p.alive ? '' : '<span class="death-mark">☠</span>'}</span>` : '';
    const visibleLevels = p.bot ? '' : [p.peacefulLevel === null || p.peacefulLevel === undefined ? null : `М ${p.peacefulLevel}`, p.mafiaLevel === null || p.mafiaLevel === undefined ? null : `МФ ${p.mafiaLevel}`].filter(Boolean).join(' · ');
    return `<div class="player ${p.alive ? '' : 'player-dead'}"><span class="player-number">${String(index + 1).padStart(2, '0')}</span><i class="player-dot ${p.alive ? '' : 'dead'}"></i>${roleCard}<span class="player-name">${escapeHtml(p.name)}${p.bot ? ` <span style="color:#8c897f">(бот · ${escapeHtml(botPersonalities[p.personality] || 'обычный')})</span>` : ''}${p.id === me.id ? ' <span style="color:#8c897f">(вы)</span>' : ''}${visibleLevels ? `<span class="player-levels">${visibleLevels}</span>` : ''}</span><span class="player-meta">${meta}${knownTeam}${role}</span></div>`;
  }).join('');
  $('#role-card').classList.toggle('hidden', !me.role);
  if (me.role) { $('#my-role').textContent = roles[me.role]?.[0] || me.role; $('#role-description').textContent = roles[me.role]?.[1] || ''; }
  $('#action-heading').textContent = ['discussion', 'speeches', 'voting', 'revote'].includes(room.phase) ? 'ДНЕВНАЯ ФАЗА' : room.phase === 'night' ? 'НОЧНЫЕ ДЕЙСТВИЯ' : room.phase === 'ended' ? 'ИТОГ ИГРЫ' : 'ГОРОДСКАЯ СВОДКА';
  renderActions(room, me, names);
  const chatList = $('.chat-list'); if (chatList) chatList.scrollTop = chatList.scrollHeight;
  if (draft) { const input = $(`#${draft.form} input`); if (input) { input.value = draft.value; input.focus({ preventScroll: true }); if (draft.start !== null) input.setSelectionRange(draft.start, draft.end); } }
  $('#log').innerHTML = room.log.slice().reverse().map((item) => `<div class="log-item"><span class="log-time">${new Date(item.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><span>${escapeHtml(item.text)}</span></div>`).join('');
  if (room.deadline) {
    const tick = () => { const el = $('#phase-timer'); if (!el) return; const sec = Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)); el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
    tick(); state.clock = setInterval(tick, 300);
  }
}
function renderActions(room, me, names) {
  const box = $('#action-content'); const live = room.players.filter((p) => p.alive);
  if (room.phase === 'lobby') {
    const needed = Math.max(0, room.minPlayers - live.length);
    const waitingForHumans = room.deadline && room.lobbyTimerKind === 'human-fill';
    const waitingToStart = room.deadline && room.lobbyTimerKind === 'start';
    box.innerHTML = waitingForHumans
      ? `<div class="action-kicker">ЖДЁМ ЛЮДЕЙ</div><div class="action-title">Комната открыта.</div><p class="action-description">Быстрый вход подберёт эту комнату автоматически. Если таймер закончится раньше, ведущий добавит ботов.</p><p class="action-status">Участников: ${live.length} / ${room.maxPlayers} · ещё ${needed} до минимума.</p>`
      : waitingToStart
        ? `<div class="action-kicker">СОСТАВ НАБРАН · СКОРО СТАРТ</div><div class="action-title">Системный ведущий готовит игру.</div><p class="action-description">Игра начнётся, когда закончится отсчёт.</p><p class="action-status">Участников: ${live.length} / ${room.maxPlayers}.</p>`
        : `<div class="action-kicker">НАБОР ИГРОКОВ</div><div class="action-title">Комната открыта.</div><p class="action-description">Быстрый вход подберёт эту комнату автоматически. Или поделитесь кодом <b style="color:#d4b58d">${room.code}</b>.</p><p class="action-status">Ещё ${needed} до минимума ${room.minPlayers}. ${room.autoFillBots ? 'Ожидание людей и автодобор ботами настроены администратором.' : 'Игра ждёт только людей; таймера автодобора нет.'}</p>`;
    if (me.teamChoiceAvailable?.length) {
      const selected = me.teamChoice;
      box.insertAdjacentHTML('beforeend', `<div class="admin-setting"><b>УРОВЕНЬ 100 · ВЫБОР КОМАНДЫ</b><p class="action-description">Конкретная роль всё равно будет случайной. Если команда заполнена, случайный игрок с обычной ролью поменяется с вами местами.</p>${me.teamChoiceAvailable.map((team) => `<button class="target-btn ${selected === team ? 'selected' : ''}" data-team-choice="${team}">${team === 'town' ? 'ИГРАТЬ ЗА ГОРОД' : 'ИГРАТЬ ЗА МАФИЮ'}</button>`).join(' ')}<p class="action-status">${selected ? `Выбрана команда: ${selected === 'town' ? 'город' : 'мафия'}.` : 'Выберите команду до старта.'}</p></div>`);
      box.querySelectorAll('[data-team-choice]').forEach((button) => button.addEventListener('click', async () => {
        try { state.room = await request('/api/team-choice', { code: state.code, playerId: state.playerId, team: button.dataset.teamChoice }); render(); }
        catch (error) { box.insertAdjacentHTML('beforeend', `<p class="action-status">${escapeHtml(error.message)}</p>`); }
      }));
    }
    return;
  }
  if (room.phase === 'ended') { box.innerHTML = `<div class="action-kicker">СИСТЕМНЫЙ ВЕДУЩИЙ · ФИНАЛ</div><div class="action-title">${escapeHtml(room.winner || 'Игра завершена')}</div><p class="action-description">Роли раскрыты. Возвращайтесь на главную, чтобы найти следующую игру.</p>${investigationHistoryMarkup(me)}`; return; }
  if (!me.alive) { box.innerHTML = `<div class="action-kicker">НАБЛЮДАТЕЛЬ</div><div class="action-title">Вы выбыли из игры.</div><p class="action-description">Следите за развязкой в хронике. Ночной и дневной чат для выбывших закрыт.</p>${investigationHistoryMarkup(me)}`; return; }
  if (room.phase === 'night' && me.role === 'don') {
    const checked = room.night?.checkedId; const result = room.night?.isMafia;
    box.innerHTML = `<div class="action-kicker">ДОН · ТАЙНАЯ ПРОВЕРКА</div><div class="action-title">Найдите комиссара.</div><p class="action-description">Вы состоите в мафии, но в эту ночь не голосуете за жертву. Результат проверки видите только вы.</p><div class="target-list">${live.filter((p) => p.id !== me.id).map((p) => `<button class="target-btn ${checked === p.id ? 'selected' : ''}" data-action="investigate" data-target="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div><p class="action-status">${checked ? room.night?.blocked ? `${escapeHtml(names.get(checked))}: проверка скрыта щитом.` : `${escapeHtml(names.get(checked))}: ${result ? 'комиссар.' : 'не комиссар.'}` : 'Выберите игрока.'}</p>`;
  } else if (room.phase === 'night' && me.team === 'mafia') {
    const voted = room.night?.votes?.[me.id];
    box.innerHTML = `<div class="action-kicker">НОЧНОЙ ВЫБОР · БЕЗ РАЗГОВОРОВ</div><div class="action-title">Выберите цель молча.</div><p class="action-description">Мафия выбирает большинство голосов. Никакого ночного чата.</p><div class="target-list">${live.filter((p) => p.team !== 'mafia').map((p) => `<button class="target-btn ${voted === p.id ? 'selected' : ''}" data-action="mafia" data-target="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div><p class="action-status">${voted ? 'Голос учтён.' : 'Ожидается ваш выбор.'}</p>`;
  } else if (room.phase === 'night' && me.role === 'detective') {
    const checked = room.night?.checkedId; const result = room.night?.isMafia;
    box.innerHTML = `<div class="action-kicker">КОМИССАР · ТАЙНАЯ ПРОВЕРКА</div><div class="action-title">Кого проверить?</div><p class="action-description">Точная роль проверенного игрока и карточка в списке станут известны только вам и останутся в личной истории до конца партии.</p><div class="target-list">${live.filter((p) => p.id !== me.id).map((p) => `<button class="target-btn ${checked === p.id ? 'selected' : ''}" data-action="investigate" data-target="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div><p class="action-status">${checked ? room.night?.blocked ? `${escapeHtml(names.get(checked))}: проверка скрыта щитом.` : `${escapeHtml(names.get(checked))}: ${escapeHtml(roles[room.night?.targetRole]?.[0] || room.night?.targetRole || (result ? 'мафия' : 'город'))}.` : 'Выберите игрока.'}</p>`;
  } else if (room.phase === 'night' && me.role === 'doctor') {
    const protectedId = room.night?.protectedId;
    box.innerHTML = `<div class="action-kicker">ДОКТОР · ТАЙНАЯ ЗАЩИТА</div><div class="action-title">Кого защитить?</div><p class="action-description">Выберите другого живого игрока. Одну цель нельзя защищать две ночи подряд.</p><div class="target-list">${live.filter((p) => p.id !== me.id && p.id !== me.lastProtectedId).map((p) => `<button class="target-btn ${protectedId === p.id ? 'selected' : ''}" data-action="protect" data-target="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div><p class="action-status">${protectedId ? `Защита выбрана: ${escapeHtml(names.get(protectedId))}.` : 'Выберите игрока для защиты.'}</p>`;
  } else if (room.phase === 'night') {
    box.innerHTML = '<div class="action-kicker">МИРНЫЙ ЖИТЕЛЬ · НОЧЬ</div><div class="action-title">Город спит.</div><p class="action-description">Ночью никто не разговаривает. Системный ведущий объявит утро.</p>';
  } else if (room.phase === 'discussion' || room.phase === 'speeches') {
    const speaker = room.players.find((p) => p.id === room.currentSpeaker); const myTurn = room.phase === 'speeches' && room.currentSpeaker === me.id;
    const content = room.phase === 'discussion'
      ? `<div class="chat-list">${room.chat.map((m) => { const player = room.players.find((item) => item.name === m.name); const levels = player && !m.bot ? [player.peacefulLevel == null ? null : `М ${player.peacefulLevel}`, player.mafiaLevel == null ? null : `МФ ${player.mafiaLevel}`].filter(Boolean).join(' · ') : ''; return `<div class="log-item"><span class="log-time">${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><span><b>${escapeHtml(m.name)}${m.bot ? ' · БОТ' : ''}${levels ? ` <small class="chat-levels">(${levels})</small>` : ''}:</b> ${escapeHtml(m.text)}</span></div>`; }).join('')}</div><form id="chat-form" class="chat-form"><input name="message" maxlength="500" placeholder="Скажите городу, что думаете…" required><button class="target-btn" type="submit">Отправить ↗</button></form>`
      : `<div class="chat-list">${room.chat.filter((m) => m.speech).map((m) => { const player = room.players.find((item) => item.name === m.name); const levels = player && !m.bot ? [player.peacefulLevel == null ? null : `М ${player.peacefulLevel}`, player.mafiaLevel == null ? null : `МФ ${player.mafiaLevel}`].filter(Boolean).join(' · ') : ''; return `<div class="log-item"><span class="log-time">${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><span><b>${escapeHtml(m.name)}${m.bot ? ' · БОТ' : ''}${levels ? ` <small class="chat-levels">(${levels})</small>` : ''}:</b> ${escapeHtml(m.text)}</span></div>`; }).join('')}</div><p class="action-description">${speaker ? `Сейчас говорит ${escapeHtml(speaker.name)}.` : 'Круг выступлений завершён.'}</p>${myTurn ? '<form id="speech-form" class="chat-form"><input name="message" maxlength="1000" placeholder="Ваше выступление…" required><button class="target-btn" type="submit">Передать слово ↗</button></form>' : '<p class="action-status">Говорит один игрок. Остальные слушают.</p>'}`;
    box.innerHTML = `<div class="action-kicker">СИСТЕМНЫЙ ВЕДУЩИЙ · ${room.phase === 'discussion' ? 'СВОБОДНЫЙ ЧАТ' : 'ОЧЕРЕДЬ'}</div><div class="action-title">${room.phase === 'discussion' ? 'Обсуждаем.' : 'Слово по очереди.'}</div>${content}`;
    const chatForm = $('#chat-form'); if (chatForm) chatForm.addEventListener('submit', (event) => { event.preventDefault(); act('chat', null, new FormData(chatForm).get('message')); });
    const speechForm = $('#speech-form'); if (speechForm) speechForm.addEventListener('submit', (event) => { event.preventDefault(); act('speech', null, new FormData(speechForm).get('message')); });
    const done = $('#done-speaking'); if (done) done.addEventListener('click', () => act('speak'));
  } else {
    const ownVote = room.votes.find((v) => v.voterId === me.id)?.targetId; const votedName = ownVote ? names.get(ownVote) : null;
    const eligible = room.phase === 'revote' ? live.filter((p) => room.candidates.includes(p.id) && p.id !== me.id) : live.filter((p) => p.id !== me.id);
    box.innerHTML = `<div class="action-kicker">${room.phase === 'revote' ? 'ПЕРЕГОЛОС · ТОЛЬКО ЛИДЕРЫ' : 'ГОЛОС ГОРОДА'}</div><div class="action-title">${votedName ? `Ваш голос: ${escapeHtml(votedName)}.` : 'Кто виноват?'}</div><p class="action-description">Выберите игрока. Голос можно изменить до конца таймера.${me.role === 'mayor' ? ' Как мэр, вы можете открыто объявить роль; двойной голос действует со следующего голосования.' : ''}</p>${me.role === 'mayor' && !me.mayorRevealed ? '<button id="reveal-mayor" class="target-btn" type="button">ОБЪЯВИТЬ СЕБЯ МЭРОМ</button>' : ''}<div class="target-list">${eligible.map((p) => `<button class="target-btn ${ownVote === p.id ? 'selected' : ''}" data-action="vote" data-target="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div><p class="action-status">${room.votes.length} голосов получено. Пропущенный голос — воздержание.</p>`;
  }
  box.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => act(button.dataset.action, button.dataset.target)));
  const revealMayor = $('#reveal-mayor'); if (revealMayor) revealMayor.addEventListener('click', () => act('reveal-mayor'));
  const effectByPhase = { discussion: 'discussion_time', voting: 'weighted_vote', revote: 'weighted_vote', night: 'check_shield' };
  const usableBonuses = (room.accountBonuses || []).filter((bonus) => bonus.effect === effectByPhase[room.phase]);
  if (me.alive && usableBonuses.length) {
    const bonusMarkup = `<div class="bonus-actions"><b>ОДНОРАЗОВЫЕ БОНУСЫ</b>${usableBonuses.map((bonus) => `<button class="text-btn" data-bonus="${escapeHtml(bonus.id)}" title="${escapeHtml(bonus.description)}">${escapeHtml(bonus.name)} · ур. ${bonus.threshold}</button>`).join(' ')}</div>`;
    box.insertAdjacentHTML('beforeend', bonusMarkup);
    box.querySelectorAll('[data-bonus]').forEach((button) => button.addEventListener('click', () => useBonus(button.dataset.bonus)));
  }
  box.insertAdjacentHTML('beforeend', investigationHistoryMarkup(me));
}
$('#room-code-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.code); $('#copy-status').textContent = 'КОД СКОПИРОВАН'; } catch { $('#copy-status').textContent = `КОД КОМНАТЫ: ${state.code}`; } });
$('#leave-room').addEventListener('click', async () => {
  try { await request('/api/leave', { code: state.code, playerId: state.playerId }); } catch {}
  try { const { account } = await request('/api/me'); setAuthenticated(account, state.token); } catch {}
  clearInterval(state.polling); clearInterval(state.clock); localStorage.removeItem('mafia-player'); state.code = null; state.playerId = null; state.room = null; showHome();
});
async function initializeClient() {
try {
  const setup = await request('/api/setup-status');
  state.needsSetup = setup.needsSetup;
  if (setup.needsSetup) {
    $('#setup-intro').classList.remove('hidden'); $('#auth-tabs').classList.add('hidden'); $('#forgot-open').classList.add('hidden'); setAuthMode('setup');
  }
  const resetToken = new URLSearchParams(location.search).get('reset');
  if (resetToken) { $('#auth-form').classList.add('hidden'); $('#auth-tabs').classList.add('hidden'); $('#forgot-open').classList.add('hidden'); $('#reset-form').classList.remove('hidden'); }
  const auth = JSON.parse(localStorage.getItem('mafia-auth') || 'null'); const saved = JSON.parse(localStorage.getItem('mafia-player') || 'null');
  if (auth?.token) {
    state.token = auth.token;
    request('/api/me').then(({ account }) => {
      setAuthenticated(account, auth.token);
      if (saved?.code && saved?.playerId && saved.token === auth.token) { state.code = saved.code; state.playerId = saved.playerId; showGame(); refresh().then(startPolling); }
    }).catch(() => { localStorage.removeItem('mafia-auth'); state.token = null; });
  }
} catch { localStorage.removeItem('mafia-auth'); localStorage.removeItem('mafia-player'); }
}
initializeClient();
