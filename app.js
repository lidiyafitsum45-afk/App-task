const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentProfile = null;
let profiles = [];       // all team members
let tasks = [];          // all tasks (live)
let filterMode = 'mine'; // 'mine' | 'all'
let selectedImportant = null;
let chainSteps = [];     // [{title, assigneeId, due}] — steps AFTER the base task
let editingTaskId = null;

const DO_FIRST_CAP = 5;
const URGENT_WINDOW_MS = 48 * 60 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session) await handleSignedIn(session.user);

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) handleSignedIn(session.user);
    if (event === 'SIGNED_OUT') location.reload();
  });

  bindStaticEvents();
})();

async function handleSignedIn(user) {
  currentUser = user;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!profile) {
    $('#name-step').classList.remove('hidden');
    $('#auth-form').classList.add('hidden');
    $('#name-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#name-input').value.trim();
      const { data } = await sb.from('profiles').insert({ id: user.id, name }).select().single();
      currentProfile = data;
      await enterApp();
    });
    return;
  }
  currentProfile = profile;
  await enterApp();
}

async function enterApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');

  const { data: allProfiles } = await sb.from('profiles').select('*').order('name');
  profiles = allProfiles || [];
  populateAssigneeSelect();

  await loadTasks();

  sb.channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => loadTasks())
    .subscribe();
}

async function loadTasks() {
  const { data } = await sb.from('tasks').select('*').order('chain_order', { ascending: true });
  tasks = data || [];
  render();
}

// ---------------------------------------------------------------
// Static UI bindings
// ---------------------------------------------------------------
function bindStaticEvents() {
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    $('#auth-status').textContent = 'Sending...';
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } });
    $('#auth-status').textContent = error ? error.message : 'Check your email for the sign-in link.';
  });

  $('#signout-btn').addEventListener('click', () => sb.auth.signOut());

  $all('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
    filterMode = btn.dataset.filter;
    $all('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    render();
  }));

  $('#new-task-btn').addEventListener('click', () => openTaskModal(null));
  $('#modal-close').addEventListener('click', closeTaskModal);
  $('#detail-close').addEventListener('click', () => $('#detail-modal').classList.add('hidden'));

  $all('.seg-btn').forEach(btn => btn.addEventListener('click', () => {
    selectedImportant = btn.dataset.important === 'true';
    $all('.seg-btn').forEach(b => b.classList.toggle('selected', b === btn));
  }));

  $('#f-chain-enable').addEventListener('change', (e) => {
    $('#chain-builder').classList.toggle('hidden', !e.target.checked);
  });
  $('#chain-add-step').addEventListener('click', () => {
    chainSteps.push({ title: '', assigneeId: '', due: '' });
    renderChainSteps();
  });

  $('#task-form').addEventListener('submit', submitTaskForm);
  $('#task-delete-btn').addEventListener('click', deleteEditingTask);

  $('#notif-btn').addEventListener('click', enablePushNotifications);
}

function populateAssigneeSelect() {
  const sel = $('#f-assignee');
  sel.innerHTML = profiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.id === currentUser.id ? ' (you)' : ''}</option>`).join('');
}

// ---------------------------------------------------------------
// Derived task properties
// ---------------------------------------------------------------
function isUrgent(t) {
  if (t.status === 'done' || !t.due_date) return false;
  return (new Date(t.due_date).getTime() - Date.now()) <= URGENT_WINDOW_MS;
}
function quadrantOf(t) {
  const u = isUrgent(t), i = t.important;
  if (u && i) return 'do';
  if (!u && i) return 'schedule';
  if (u && !i) return 'delegate';
  return 'eliminate';
}
function isVisible(t) {
  // Chain tasks that haven't activated yet stay hidden from the dashboard.
  if (t.chain_id && t.chain_status === 'queued') return false;
  return true;
}
function profileName(id) {
  const p = profiles.find(p => p.id === id);
  return p ? p.name : '—';
}
function chainLabel(t) {
  if (!t.chain_id) return '';
  const siblings = tasks.filter(x => x.chain_id === t.chain_id).sort((a, b) => a.chain_order - b.chain_order);
  const pos = siblings.findIndex(x => x.id === t.id) + 1;
  return `${pos} of ${siblings.length}`;
}

// ---------------------------------------------------------------
// Render
// ---------------------------------------------------------------
function render() {
  const visible = tasks.filter(isVisible).filter(t => filterMode === 'mine' ? t.assignee_id === currentUser.id : true);
  const quads = { do: [], schedule: [], delegate: [], eliminate: [] };
  visible.forEach(t => quads[quadrantOf(t)].push(t));

  Object.entries(quads).forEach(([key, list]) => {
    const el = $('#list-' + key);
    if (!list.length) { el.innerHTML = `<div class="empty-hint">Nothing here.</div>`; return; }
    el.innerHTML = list.map(taskCardHtml).join('');
  });

  $all('.task-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.task-check')) return;
      openDetail(card.dataset.id);
    });
  });
  $all('.task-check').forEach(chk => {
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDone(chk.dataset.id);
    });
  });

  // Do First soft cap — checked against the current user's own active load
  const mineDoFirst = tasks.filter(isVisible).filter(t => t.assignee_id === currentUser.id && t.status !== 'done' && quadrantOf(t) === 'do');
  const capEl = $('#cap-warning');
  if (mineDoFirst.length >= DO_FIRST_CAP) {
    capEl.classList.remove('hidden');
    capEl.textContent = `You have ${mineDoFirst.length} tasks in Do First — consider clearing or re-triaging one before adding more.`;
  } else {
    capEl.classList.add('hidden');
  }
}

function taskCardHtml(t) {
  const due = t.due_date ? new Date(t.due_date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return `
    <div class="task-card ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
      <div class="task-card-top">
        <div class="task-check ${t.status === 'done' ? 'checked' : ''}" data-id="${t.id}">${t.status === 'done' ? '✓' : ''}</div>
        <div class="task-title">${escapeHtml(t.title)}</div>
      </div>
      <div class="task-meta">
        <span>${escapeHtml(profileName(t.assignee_id))}</span>
        ${due ? `<span>${due}</span>` : ''}
        ${t.chain_id ? `<span class="chain-pill">${chainLabel(t)}</span>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------
// Toggle done (also drives chain advancement, via DB trigger)
// ---------------------------------------------------------------
async function toggleDone(id) {
  const t = tasks.find(x => x.id === id);
  const newStatus = t.status === 'done' ? 'todo' : 'done';
  await sb.from('tasks').update({ status: newStatus }).eq('id', id);
}

// ---------------------------------------------------------------
// Task modal — create / edit
// ---------------------------------------------------------------
function openTaskModal(taskId) {
  editingTaskId = taskId;
  const t = taskId ? tasks.find(x => x.id === taskId) : null;

  $('#modal-title').textContent = t ? 'Edit task' : 'New task';
  $('#task-delete-btn').classList.toggle('hidden', !t);
  $('#f-title').value = t ? t.title : '';
  $('#f-desc').value = t ? (t.description || '') : '';
  $('#f-assignee').value = t ? t.assignee_id : currentUser.id;
  $('#f-due').value = t && t.due_date ? toLocalInputValue(t.due_date) : '';

  selectedImportant = t ? t.important : null;
  $all('.seg-btn').forEach(b => b.classList.toggle('selected', t && (b.dataset.important === String(t.important))));

  // Chains can only be created on a brand-new task, to keep ordering unambiguous.
  const chainToggleRow = $('.chain-block');
  chainToggleRow.classList.toggle('hidden', !!t);
  $('#f-chain-enable').checked = false;
  $('#chain-builder').classList.add('hidden');
  chainSteps = [];
  renderChainSteps();

  $('#task-modal').classList.remove('hidden');
}
function closeTaskModal() { $('#task-modal').classList.add('hidden'); }

function renderChainSteps() {
  const el = $('#chain-steps');
  el.innerHTML = chainSteps.map((s, i) => `
    <div class="chain-step" draggable="true" data-idx="${i}">
      <span class="drag-handle">⠿</span>
      <input type="text" placeholder="Step title" value="${escapeHtml(s.title)}" data-field="title" data-idx="${i}" />
      <select data-field="assigneeId" data-idx="${i}">
        <option value="">Assignee…</option>
        ${profiles.map(p => `<option value="${p.id}" ${p.id === s.assigneeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
      </select>
      <input type="datetime-local" data-field="due" data-idx="${i}" value="${s.due || ''}" />
      <button type="button" class="remove-step" data-idx="${i}">✕</button>
    </div>`).join('');

  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = +e.target.dataset.idx, field = e.target.dataset.field;
      chainSteps[idx][field] = e.target.value;
    });
  });
  el.querySelectorAll('.remove-step').forEach(btn => {
    btn.addEventListener('click', () => { chainSteps.splice(+btn.dataset.idx, 1); renderChainSteps(); });
  });

  let dragIdx = null;
  el.querySelectorAll('.chain-step').forEach(row => {
    row.addEventListener('dragstart', () => { dragIdx = +row.dataset.idx; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', () => {
      const dropIdx = +row.dataset.idx;
      const [moved] = chainSteps.splice(dragIdx, 1);
      chainSteps.splice(dropIdx, 0, moved);
      renderChainSteps();
    });
  });
}

async function submitTaskForm(e) {
  e.preventDefault();
  const title = $('#f-title').value.trim();
  const description = $('#f-desc').value.trim();
  const assignee_id = $('#f-assignee').value;
  const due_date = $('#f-due').value ? new Date($('#f-due').value).toISOString() : null;
  const important = selectedImportant === null ? false : selectedImportant;

  if (editingTaskId) {
    await sb.from('tasks').update({ title, description, assignee_id, due_date, important }).eq('id', editingTaskId);
    closeTaskModal();
    return;
  }

  const useChain = $('#f-chain-enable').checked && chainSteps.length > 0;
  const chain_id = useChain ? crypto.randomUUID() : null;

  const base = {
    title, description, assignee_id, due_date, important,
    created_by: currentProfile.id,
    chain_id, chain_order: useChain ? 0 : null, chain_status: useChain ? 'active' : null,
  };
  const { data: baseTask } = await sb.from('tasks').insert(base).select().single();

  if (useChain) {
    const rows = chainSteps
      .filter(s => s.title.trim())
      .map((s, i) => ({
        title: s.title.trim(),
        assignee_id: s.assigneeId || null,
        due_date: s.due ? new Date(s.due).toISOString() : null,
        important,
        created_by: currentProfile.id,
        chain_id,
        chain_order: i + 1,
        chain_status: 'queued',
      }));
    if (rows.length) await sb.from('tasks').insert(rows);
  }

  closeTaskModal();
}

async function deleteEditingTask() {
  if (!editingTaskId) return;
  await sb.from('tasks').delete().eq('id', editingTaskId);
  closeTaskModal();
}

// ---------------------------------------------------------------
// Detail modal (includes chain reorder for queued siblings)
// ---------------------------------------------------------------
function openDetail(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  $('#detail-title').textContent = t.title;

  let chainHtml = '';
  if (t.chain_id) {
    const siblings = tasks.filter(x => x.chain_id === t.chain_id).sort((a, b) => a.chain_order - b.chain_order);
    chainHtml = `<div class="d-row"><div class="d-label">CHAIN</div>${siblings.map(s => `
      <div class="chain-list-item ${s.chain_status === 'active' ? 'active-step' : ''} ${s.chain_status === 'done' ? 'done-step' : ''}"
           draggable="${s.chain_status === 'queued'}" data-id="${s.id}">
        <span>${escapeHtml(s.title)} — ${escapeHtml(profileName(s.assignee_id))}</span>
        <span class="chain-pill">${s.chain_status}</span>
      </div>`).join('')}</div>`;
  }

  $('#detail-body').innerHTML = `
    <div class="d-row"><div class="d-label">ASSIGNEE</div>${escapeHtml(profileName(t.assignee_id))}</div>
    ${t.description ? `<div class="d-row"><div class="d-label">DESCRIPTION</div>${escapeHtml(t.description)}</div>` : ''}
    ${t.due_date ? `<div class="d-row"><div class="d-label">DUE</div>${new Date(t.due_date).toLocaleString()}</div>` : ''}
    <div class="d-row"><div class="d-label">STATUS</div>${t.status}</div>
    ${chainHtml}
    <div class="modal-actions">
      <button type="button" class="ghost-btn" id="detail-edit-btn">Edit</button>
      <button type="button" class="primary-btn" id="detail-toggle-btn">${t.status === 'done' ? 'Mark not done' : 'Mark done'}</button>
    </div>`;

  $('#detail-edit-btn').addEventListener('click', () => { $('#detail-modal').classList.add('hidden'); openTaskModal(t.id); });
  $('#detail-toggle-btn').addEventListener('click', async () => { await toggleDone(t.id); $('#detail-modal').classList.add('hidden'); });

  // Drag reorder for queued chain siblings
  let dragId = null;
  $all('.chain-list-item[draggable=true]').forEach(row => {
    row.addEventListener('dragstart', () => dragId = row.dataset.id);
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', async () => {
      const dropId = row.dataset.id;
      if (dragId === dropId) return;
      const siblings = tasks.filter(x => x.chain_id === t.chain_id).sort((a, b) => a.chain_order - b.chain_order);
      const queued = siblings.filter(s => s.chain_status === 'queued');
      const dragTask = queued.find(s => s.id === dragId);
      const otherQueued = queued.filter(s => s.id !== dragId);
      const dropIdx = otherQueued.findIndex(s => s.id === dropId);
      otherQueued.splice(dropIdx, 0, dragTask);
      const lockedCount = siblings.length - queued.length;
      await Promise.all(otherQueued.map((s, i) => sb.from('tasks').update({ chain_order: lockedCount + i }).eq('id', s.id)));
      openDetail(id);
    });
  });

  $('#detail-modal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------
async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push notifications are not supported in this browser.');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  await sb.from('profiles').update({ push_subscription: sub.toJSON() }).eq('id', currentUser.id);
  $('#notif-btn').textContent = '🔔 On';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ---------------------------------------------------------------
// Utils
// ---------------------------------------------------------------
function toLocalInputValue(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
