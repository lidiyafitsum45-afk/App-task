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
      const { data, error } = await sb.from('profiles').insert({ id: user.id, name }).select().single();
      if (error) { alert('Could not create profile: ' + error.message); return; }
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
  const { data, error } = await sb.from('tasks').select('*').order('chain_order', { ascending: true });
  if (error) { console.error('loadTasks failed:', error); alert('Could not load tasks: ' + error.message); return; }
  tasks = data || [];
  render();
}

// ---------------------------------------------------------------
// Static UI bindings
// ---------------------------------------------------------------
let authMode = 'signin'; // 'signin' | 'signup'

function bindStaticEvents() {
  $('#auth-toggle-mode').addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    $('#auth-submit-btn').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
    $('#auth-mode-sub').textContent = authMode === 'signin'
      ? 'Sign in with your work email and password.'
      : 'Create your account with a work email and password.';
    $('#auth-toggle-mode').textContent = authMode === 'signin'
      ? 'Need an account? Create one'
      : 'Already have an account? Sign in';
    $('#auth-status').textContent = '';
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;

    if (authMode === 'signup') {
      $('#auth-status').textContent = 'Creating account...';
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) { $('#auth-status').textContent = error.message; return; }
      if (data.session) {
        $('#auth-status').textContent = '';
        await handleSignedIn(data.user);
      } else {
        $('#auth-status').textContent = 'Account created. Check your email to confirm, then sign in.';
      }
      return;
    }

    $('#auth-status').textContent = 'Signing in...';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $('#auth-status').textContent = error ? error.message : '';
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
  const { error } = await sb.from('tasks').update({ status: newStatus }).eq('id', id);
  if (error) alert('Could not update task: ' + error.message);
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
