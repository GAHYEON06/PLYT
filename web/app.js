'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { token: sessionStorage.getItem('plyt-token') || '', user: null, spaces: [], saved: [], requests: [], page: 'discover', category: '전체', query: '', authMode: 'login', selectedSpace: null, selectedRequest: null, busy: false };
const statuses = { pending: '요청 접수', proposed: '변경 제안 도착', accepted_a: '기존 예약자 수락', accepted_b: '양측 수락 완료', confirmed: '업체 확인 완료', cancelled: '요청 취소', declined: '제안 거절', expired: '응답 기한 만료' };
const descriptions = { pending: '업체가 기존 예약과 대체 가능한 시간을 확인하고 있어요.', proposed: '기존 예약자에게 대체 시간과 보상을 제안했어요. 수락을 기다리고 있어요.', accepted_a: '기존 예약자가 이동에 동의했어요. 요청 고객의 조건 확인과 수락이 필요해요.', accepted_b: '양쪽 모두 동의했어요. 업체가 원래 예약 시스템의 변경 결과를 확인해야 해요.', confirmed: '업체가 원래 예약 시스템에서 변경을 반영했다고 기록했어요. 결제·보상 지급은 별도이며 자동 처리되지 않아요.', cancelled: '요청자가 요청을 취소했어요. 예약 변경은 더 진행되지 않아요.', declined: '제안이 거절되어 변경 진행이 종료됐어요.', expired: '제안의 응답 기한이 지났어요. 업체에 문의해 새로운 요청을 진행해주세요.' };
const money = n => Number(n || 0).toLocaleString('ko-KR') + '원';
const terminal = s => ['confirmed', 'cancelled', 'declined'].includes(s);
const expired = r => !terminal(r.status) && r.expiresAt && r.expiresAt * 1000 < Date.now();
const statusOf = r => expired(r) ? 'expired' : r.status;
function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function button(text, cls, fn) { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; }
function toast(message) { const t = $('#toast'); t.textContent = message; t.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('visible'), 4000); }
function openDialog(id) { const d = $('#' + id); if (!d.open) d.showModal(); }
function closeDialog(id) { $('#' + id).close(); }
async function api(path, method = 'GET', payload) {
  let response;
  try { response = await fetch(path, { method, headers: { ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error('서버에 연결할 수 없어요. 연결 상태를 확인한 뒤 다시 시도해주세요.'); }
  const data = await response.json().catch(() => ({ error: '서버 응답을 확인할 수 없어요.' }));
  if (!response.ok) { if (response.status === 401 && !path.startsWith('/api/auth/')) { clearSession(); } throw new Error(data.error || '요청 처리에 실패했어요.'); }
  return data;
}
function clearSession() { state.token = ''; state.user = null; state.saved = []; state.requests = []; sessionStorage.removeItem('plyt-token'); renderAccount(); renderAll(); }
async function loadPrivate() {
  if (!state.token) return;
  const activeToken = state.token;
  const [saved, requests] = await Promise.all([api('/api/favorites'), api('/api/requests')]);
  if (state.token !== activeToken) return;
  state.saved = saved.ids; state.requests = requests.requests; renderAll();
}
function renderAccount() {
  $('#owner-nav').hidden = state.user?.role !== 'owner';
  $('#auth-button').textContent = state.user ? '로그아웃' : '로그인 / 가입';
  const box = $('#sidebar-account'); box.replaceChildren();
  const avatar = el('span', 'avatar', state.user ? state.user.name.slice(0, 1) : 'P');
  const copy = el('div', 'account-copy'); copy.append(el('strong', '', state.user ? state.user.name + ' 님' : '나의 시간을 연결해요'), el('small', '', state.user ? (state.user.role === 'owner' ? '사장님 계정' : 'PLYT 멤버') : '로그인하고 시작해보세요'));
  box.append(avatar, copy);
}
function needLogin() { if (state.user) return true; setAuthMode('login'); openDialog('auth-dialog'); return false; }
function empty(container, title, description, login = false) {
  const node = el('div', 'empty'); node.append(el('span', 'empty-symbol', '✳'), el('strong', '', title), el('p', '', description));
  if (login) node.append(button('로그인하고 이어가기 ↗', 'button secondary', () => needLogin()));
  container.replaceChildren(node);
}
function spaceCard(space) {
  const card = el('article', 'space-card'); const photo = el('div', 'card-photo'); const img = el('img');
  img.src = 'https://images.unsplash.com/' + space.image + '?auto=format&fit=crop&w=800&q=85'; img.alt = space.name + ' 분위기의 참고 사진'; img.loading = 'lazy';
  const saved = state.saved.includes(space.id); const save = button(saved ? '♥' : '♡', 'save-button' + (saved ? ' saved' : ''), async () => {
    if (!needLogin()) return; save.disabled = true;
    try { await api('/api/favorites', 'POST', { spaceId: space.id, saved: !saved }); state.saved = saved ? state.saved.filter(id => id !== space.id) : [...state.saved, space.id]; renderAll(); toast(saved ? '저장한 공간에서 삭제했어요.' : '마음에 드는 공간을 저장했어요.'); } catch (e) { toast(e.message); } finally { save.disabled = false; }
  });
  save.setAttribute('aria-label', space.name + (saved ? ' 저장 취소' : ' 저장')); save.setAttribute('aria-pressed', String(saved));
  photo.append(img, el('span', 'card-badge', '예시 공간 · 최대 ' + space.capacity + '인'), save);
  const meta = el('div', 'card-meta'); meta.append(el('span', '', space.area), el('span', '', space.category));
  const bottom = el('div', 'card-bottom'); const price = el('div'); const strong = el('strong', '', money(space.price)); strong.append(el('span', '', '부터'));
  price.append(el('small', '', '예시 기본 이용료 · 2시간'), strong); bottom.append(price, button('희망 시간 요청 ↗', 'request-button', () => openRequest(space)));
  card.append(photo, meta, el('h3', '', space.name), el('p', '', space.description), bottom); return card;
}
function renderSpaces() {
  const list = state.spaces.filter(s => (state.category === '전체' || s.category === state.category) && (!state.query || (s.name + ' ' + s.area + ' ' + s.category).toLowerCase().includes(state.query.toLowerCase())));
  const grid = $('#space-grid'); grid.replaceChildren(...list.map(spaceCard));
  if (!list.length) empty(grid, '조건에 맞는 공간이 없어요.', '다른 검색어나 공간 유형으로 다시 찾아보세요.');
  $('#space-count').textContent = list.length + '개의 공간';
  const savedGrid = $('#saved-grid');
  if (!state.user) empty(savedGrid, '취향에 맞는 공간을 모아보세요.', '로그인하면 저장한 공간을 앱과 웹에서 함께 확인할 수 있어요.', true);
  else { const saved = state.spaces.filter(s => state.saved.includes(s.id)); savedGrid.replaceChildren(...saved.map(spaceCard)); if (!saved.length) empty(savedGrid, '아직 저장한 공간이 없어요.', '공간 사진의 ♡를 눌러 나만의 목록을 만들어보세요.'); }
}
function badge(r) { return el('span', 'status ' + statusOf(r), statuses[statusOf(r)] || r.status); }
function requestRow(r, mode) {
  const row = el('article', 'request-row'); const copy = el('div'); copy.append(badge(r), el('h3', '', r.space), el('p', '', r.date + ' · ' + r.time + ' / ' + r.duration / 60 + '시간'));
  copy.append(el('p', '', mode === 'offers' ? '이동 제안: ' + r.alternativeDate + ' ' + r.alternativeTime : '추가 부담 한도 ' + money(r.budget)));
  const side = el('div', 'row-side'); side.append(el('small', '', mode === 'offers' ? '제안 보상 ' + money(r.reward) : new Date(r.createdAt * 1000).toLocaleDateString('ko-KR')), button('자세히 보기 ↗', 'button secondary', () => openDetail(r.id)));
  row.append(copy, side); return row;
}
function renderRequests() {
  const mine = state.requests.filter(r => r.requesterId === state.user?.id); const offers = state.requests.filter(r => r.recipientId === state.user?.id);
  $('#saved-count').textContent = state.saved.length; $('#requests-count').textContent = mine.filter(r => !terminal(r.status)).length; $('#offers-count').textContent = offers.filter(r => r.status === 'proposed' && !expired(r)).length;
  for (const [id, list, mode] of [['request-list', mine, 'requests'], ['offer-list', offers, 'offers'], ['owner-list', state.requests, 'owner']]) {
    const root = $('#' + id);
    if (!state.user) empty(root, '나의 시간을 이어가 보세요.', '로그인하면 요청과 도착한 제안의 진행 상황을 확인할 수 있어요.', true);
    else if (mode === 'owner' && state.user.role !== 'owner') empty(root, '사장님 전용 화면이에요.', '운영 권한이 있는 계정으로 로그인해주세요.');
    else if (!list.length) empty(root, mode === 'offers' ? '아직 도착한 제안이 없어요.' : '아직 등록된 요청이 없어요.', mode === 'offers' ? '업체가 대체 시간 제안을 보내면 여기에 표시돼요.' : '마음에 드는 공간에서 원하는 시간을 요청해보세요.');
    else root.replaceChildren(...list.map(r => requestRow(r, mode)));
  }
  const statRoot = $('#owner-stats'); statRoot.replaceChildren();
  for (const [label, value] of [['전체 요청', state.requests.length], ['새 요청', state.requests.filter(r => r.status === 'pending').length], ['양측 수락', state.requests.filter(r => r.status === 'accepted_b').length], ['업체 확인 완료', state.requests.filter(r => r.status === 'confirmed').length]]) { const n = el('div', 'stat'); n.append(el('small', '', label), el('b', '', String(value))); statRoot.append(n); }
}
function renderAll() { renderSpaces(); renderRequests(); }
function navigate(page, updateHash = true) {
  if (!['discover', 'saved', 'requests', 'offers', 'owner'].includes(page)) page = 'discover';
  if (page === 'owner' && state.user?.role !== 'owner') page = 'discover';
  state.page = page; $$('.page-view').forEach(n => n.hidden = n.id !== page + '-view');
  $$('[data-page]').forEach(n => { const active = n.dataset.page === page; n.classList.toggle('active', active); if (active) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
  $('#page-label').textContent = { discover: '공간 둘러보기', saved: '저장한 공간', requests: '내 요청', offers: '도착한 제안', owner: '사장님 관리' }[page];
  if (updateHash) history.replaceState(null, '', '#' + page); window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.user && ['requests', 'offers', 'owner'].includes(page)) loadPrivate().catch(e => toast(e.message));
}
function setAuthMode(mode) {
  state.authMode = mode; const register = mode === 'register';
  $('#login-tab').classList.toggle('active', !register); $('#register-tab').classList.toggle('active', register);
  $('#auth-title').textContent = register ? '새로운 가능성의 시작.' : '다시 만나 반가워요.';
  $('#auth-description').textContent = register ? '내 일정을 조금 더 유연하게 만들어보세요.' : '내 시간의 가능성을 이어가 볼까요?';
  $('#auth-submit').textContent = register ? '가입하고 시작하기 ↗' : '로그인 ↗';
  $('#name-field').hidden = !register; $('#name-field input').required = register;
  $('#owner-register-fields').hidden = !register;
  const ownerEnabled = register && $('#auth-form [name=owner]').checked;
  $('#setup-key-field').hidden = !ownerEnabled; $('#setup-key-field input').required = ownerEnabled;
  $('#auth-form [name=password]').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-form .form-error').textContent = '';
}
function dateTomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
function timeOptions(select, duration = 120) {
  const previous = select.value; const choices = [];
  for (let minute = 9 * 60; minute + Number(duration) <= 22 * 60; minute += 30) {
    const t = String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
    const option = el('option', '', t); option.value = t; choices.push(option);
  }
  select.replaceChildren(...choices);
  const preferred = choices.some(o => o.value === previous) ? previous : choices.some(o => o.value === '14:00') ? '14:00' : choices[0]?.value;
  if (preferred) select.value = preferred;
}
function openRequest(space) {
  if (!needLogin()) return;
  state.selectedSpace = space; const form = $('#request-form'); form.reset(); $('#request-space-name').textContent = space.name;
  form.elements.date.min = dateTomorrow(); form.elements.date.value = dateTomorrow(); timeOptions(form.elements.time, Number(form.elements.duration.value));
  $('#request-form .form-error').textContent = ''; updatePrice(); openDialog('request-dialog');
}
function updatePrice() { if (!state.selectedSpace) return; const f = $('#request-form'); $('#request-price').textContent = money(state.selectedSpace.price * Number(f.elements.duration.value) / 120); $('#request-budget').textContent = money(f.elements.budget.value); }
function field(label, name, type = 'text', value = '', required = true) { const l = el('label', 'field', label); const input = el('input'); input.type = type; input.name = name; input.value = value; input.required = required; input.maxLength = type === 'email' ? 254 : 120; l.append(input); return l; }
function detailItem(dl, title, value) { const pair = el('div'); pair.append(el('dt', '', title), el('dd', '', value)); dl.append(pair); }
async function performAction(id, data, form) {
  const buttons = form ? $$('button', form) : $$('#detail-content button'); buttons.forEach(b => b.disabled = true);
  try { await api('/api/requests/' + id + '/action', 'POST', data); await loadPrivate(); await openDetail(id, true); toast('변경 사항을 저장했어요.'); }
  catch (e) { if (form && $('.form-error', form)) $('.form-error', form).textContent = e.message; else toast(e.message); }
  finally { buttons.forEach(b => b.disabled = false); }
}
async function openDetail(id, keepOpen = false) {
  const r = state.requests.find(x => x.id === id); if (!r) return;
  state.selectedRequest = id; const root = $('#detail-content'); root.replaceChildren();
  const head = el('div', 'detail-head'); const h = el('div'); h.append(el('h2', '', r.space), el('small', '', '요청 번호 · ' + r.id.slice(0, 10).toUpperCase())); head.append(h, badge(r)); root.append(head, el('div', 'status-explainer', descriptions[statusOf(r)] || '진행 상황을 확인해주세요.'));
  const mine = r.requesterId === state.user?.id, recipient = r.recipientId === state.user?.id, owner = state.user?.role === 'owner';
  const dl = el('dl', 'detail-dl'); detailItem(dl, '원래 / 희망 시간', r.date + ' ' + r.time); detailItem(dl, '이용 시간', r.duration / 60 + '시간');
  detailItem(dl, '요청 고객', r.requesterName); detailItem(dl, '추가 부담 한도', money(r.budget)); detailItem(dl, '예시 기본 이용료', money(r.basePrice));
  if (r.alternativeDate) { detailItem(dl, '기존 예약자의 대체 시간', r.alternativeDate + ' ' + r.alternativeTime); detailItem(dl, '이동 제안 보상', money(r.reward)); detailItem(dl, '기존 예약자', r.recipientName); detailItem(dl, '응답 기한', new Date(r.expiresAt * 1000).toLocaleString('ko-KR')); }
  if (r.status === 'confirmed') { detailItem(dl, '결제', '미연동 · 자동 결제 없음'); detailItem(dl, '보상 지급', '미지급 · 업체 별도 처리'); detailItem(dl, '업체 확인 참조', r.confirmationReference); }
  if (owner && r.bookingReference) detailItem(dl, '기존 예약 참조', r.bookingReference);
  root.append(dl);
  if (recipient && r.status !== 'cancelled' && r.status !== 'declined') root.append(el('p', 'detail-note', '기존 예약자에게 안내: 원래 이용 시간을 대체 시간으로 옮기는 제안입니다. 제안을 수락해도 업체가 원래 예약을 반영하기 전까지 변경은 확정되지 않아요.'));
  const actions = el('div', 'detail-actions');
  if (!expired(r)) {
    if (recipient && r.status === 'proposed') actions.append(button('대체 시간으로 이동 수락', 'button', () => performAction(id, { action: 'accept' })));
    if (mine && r.status === 'accepted_a') actions.append(button('조건 확인 후 수락', 'button', () => performAction(id, { action: 'accept' })));
    if ((recipient || mine) && ['proposed', 'accepted_a'].includes(r.status)) actions.append(button('제안 거절', 'button secondary', () => performAction(id, { action: 'decline' })));
  }
  if (mine && !terminal(r.status)) actions.append(button('요청 취소', 'button danger', () => confirmCancel(id)));
  root.append(actions);
  if (owner && r.status === 'pending') root.append(proposeForm(r));
  if (owner && r.status === 'accepted_b') root.append(confirmForm(r));
  const audit = el('section', 'detail-section'); audit.append(el('h3', '', '진행 기록')); const timeline = el('ol', 'timeline'); timeline.append(el('li', '', '기록을 불러오고 있어요.')); audit.append(timeline); root.append(audit);
  if (!keepOpen) openDialog('detail-dialog');
  try { const data = await api('/api/requests/' + id + '/events'); if (state.selectedRequest !== id) return; timeline.replaceChildren(...data.events.map(e => { const li = el('li'); const t = el('time', '', new Date(e.created_at * 1000).toLocaleString('ko-KR')); li.append(el('span', '', statuses[e.action] || e.action), t); return li; })); } catch (e) { timeline.replaceChildren(el('li', '', e.message)); }
}
function confirmCancel(id) {
  const actions = $('#detail-content .detail-actions'); actions.replaceChildren(el('p', 'detail-note', '이 희망 시간 요청을 취소할까요? 취소 후에는 새 요청을 등록할 수 있어요.'), button('취소 확정', 'button danger', () => performAction(id, { action: 'cancel' })), button('계속 기다리기', 'button secondary', () => openDetail(id, true)));
}
function proposeForm(r) {
  const section = el('section', 'detail-section'); section.append(el('h3', '', '기존 예약자에게 변경 제안'));
  const f = el('form', 'owner-form'); const email = field('기존 예약자의 가입 이메일', 'recipientEmail', 'email'); email.append(el('small', '', '이미 가입한 고객 계정으로 제안을 전달해요. 문자 알림은 발송되지 않아요.'));
  const grid = el('div', 'form-grid'); const date = field('대체 날짜', 'alternativeDate', 'date', dateTomorrow()); $('input', date).min = dateTomorrow();
  const time = el('label', 'field', '대체 시작 시간'); const select = el('select'); select.name = 'alternativeTime'; timeOptions(select, r.duration); time.append(select);
  const reward = field('이동 보상 (원)', 'reward', 'number', String(Math.min(r.budget, 10000))); $('input', reward).min = '0'; $('input', reward).max = String(r.budget); $('input', reward).step = '1000';
  grid.append(date, time, reward, field('기존 예약 확인 번호', 'bookingReference'));
  const error = el('p', 'form-error'); error.setAttribute('role', 'alert'); const submit = el('button', 'button full', '변경 제안 전달하기 ↗'); submit.type = 'submit';
  f.append(email, grid, el('p', 'detail-note', '동일 공간·동일 이용 시간의 변경만 제안해주세요. 업체가 원래 예약과 대체 시간의 가용성을 직접 확인해야 해요.'), error, submit);
  f.addEventListener('submit', e => { e.preventDefault(); const data = Object.fromEntries(new FormData(f)); data.recipientEmail = data.recipientEmail.trim(); data.bookingReference = data.bookingReference.trim(); data.action = 'propose'; data.reward = Number(data.reward); performAction(r.id, data, f); }); section.append(f); return section;
}
function confirmForm(r) {
  const section = el('section', 'detail-section'); section.append(el('h3', '', '원래 예약 시스템 반영 확인'));
  const f = el('form', 'owner-form'); const check = el('label', 'check'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.required = true; checkbox.name = 'originalSystemUpdated'; check.append(checkbox, el('span', '', '기존 고객의 대체 예약과 신규 고객의 희망 시간 예약을 원래 시스템에 반영했어요.'));
  const error = el('p', 'form-error'); error.setAttribute('role', 'alert'); const submit = el('button', 'button full', '업체 확인 완료로 기록'); submit.type = 'submit';
  f.append(field('원래 예약 시스템 확인 번호 / 참조', 'confirmationReference'), check, el('p', 'detail-note', '이 작업은 업체의 확인 기록을 저장해요. 외부 예약 변경·결제·보상 지급을 자동 실행하지 않아요.'), error, submit);
  f.addEventListener('submit', e => { e.preventDefault(); performAction(r.id, { action: 'confirm', originalSystemUpdated: checkbox.checked, confirmationReference: f.elements.confirmationReference.value }, f); }); section.append(f); return section;
}
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget; const submit = $('button[type=submit]', f); const error = $('.form-error', f); error.textContent = ''; submit.disabled = true;
  try { const payload = { email: f.elements.email.value.trim(), password: f.elements.password.value }; if (state.authMode === 'register') { payload.name = f.elements.name.value.trim(); payload.owner = f.elements.owner.checked; if (payload.owner) payload.setupKey = f.elements.setupKey.value.trim(); }
    const data = await api('/api/auth/' + (state.authMode === 'register' ? 'register' : 'login'), 'POST', payload); state.token = data.token; state.user = data.user; sessionStorage.setItem('plyt-token', data.token); f.reset(); renderAccount(); closeDialog('auth-dialog'); await loadPrivate(); toast(data.user.name + ' 님, 반가워요.'); if (data.user.role === 'owner') navigate('owner');
  } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; }
});
$('#request-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget; const submit = $('button[type=submit]', f); const error = $('.form-error', f); error.textContent = ''; submit.disabled = true;
  try { const data = Object.fromEntries(new FormData(f)); data.spaceId = state.selectedSpace.id; data.duration = Number(data.duration); data.budget = Number(data.budget); const request = await api('/api/requests', 'POST', data); closeDialog('request-dialog'); await loadPrivate(); navigate('requests'); await openDetail(request.id); toast('희망 시간 요청을 접수했어요.'); }
  catch (e) { error.textContent = e.message; } finally { submit.disabled = false; }
});
$('#auth-button').addEventListener('click', async () => { if (state.user) { try { await api('/api/auth/logout', 'POST', {}); clearSession(); navigate('discover'); toast('로그아웃했어요.'); } catch (e) { toast(e.message); } } else { setAuthMode('login'); openDialog('auth-dialog'); } });
$('#login-tab').addEventListener('click', () => setAuthMode('login')); $('#register-tab').addEventListener('click', () => setAuthMode('register'));
$('#auth-form [name=owner]').addEventListener('change', e => { $('#setup-key-field').hidden = !e.target.checked; $('#setup-key-field input').required = e.target.checked; });
$('#request-form [name=duration]').addEventListener('change', () => { const form = $('#request-form'); timeOptions(form.elements.time, Number(form.elements.duration.value)); updatePrice(); }); $('#request-form [name=budget]').addEventListener('input', updatePrice); timeOptions($('#request-form [name=time]'));
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target !== d) return; const rect = d.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) d.close(); }));
$$('[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)));
$$('[data-category]').forEach(b => b.addEventListener('click', () => { state.category = b.dataset.category; $$('[data-category]').forEach(c => { c.classList.toggle('active', c === b); c.setAttribute('aria-pressed', String(c === b)); }); renderSpaces(); }));
$('#search').addEventListener('input', e => { state.query = e.target.value.trim(); renderSpaces(); });
$('#how-button').addEventListener('click', () => openDialog('how-dialog'));
$('#refresh-button').addEventListener('click', async e => { const control = e.currentTarget; control.disabled = true; try { await loadPrivate(); toast('최신 상태로 불러왔어요.'); } catch (err) { toast(err.message); } finally { control.disabled = false; } });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== 'catalog') navigate(h || 'discover', false); });
window.addEventListener('focus', () => { if (state.user && !document.querySelector('dialog[open]')) loadPrivate().catch(() => {}); });
async function start() {
  renderAccount(); for (let i = 0; i < 3; i++) $('#space-grid').append(el('div', 'skeleton'));
  try { const data = await api('/api/spaces'); state.spaces = data.spaces; $('#connection').textContent = '서버 연결됨'; $('#connection').classList.add('online');
    if (state.token) { try { state.user = await api('/api/me'); await loadPrivate(); } catch (e) { clearSession(); toast(e.message); } }
    renderAccount(); renderAll(); navigate(location.hash.slice(1) || 'discover', false);
  } catch (e) { $('#connection').textContent = '서버 연결 확인 필요'; const warning = el('div', 'app-warning'); warning.append(el('strong', '', '공간을 불러올 수 없어요.'), el('p', '', e.message), button('다시 연결하기 ↻', 'button secondary', () => { $('#space-grid').replaceChildren(); start(); })); $('#space-grid').replaceChildren(warning); }
}
start();
