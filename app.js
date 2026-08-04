const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentProfile = null;
let profiles = [];
let tasks = [];
let tags = [];
let filterMode = 'mine';
let editingTaskId = null;
let selectedQuadrant = null;   // {important, urgent}
let selectedTagIds = new Set();
let attachmentRows = [];       // [{label, url}]
let subtaskRows = [];          // [{title, assigneeId, due}] — only used at creation time
let chainSteps = [];
let progressRange = { days: 7, from: null, to: null };

const DO_FIRST_CAP = 5;
const CARD_LIST_CAP = 5;

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------
// Boot — bind events first, unconditionally, so a later error can
// never leave a form without its handlers attached.
// ---------------------------------------------------------------
bindStaticEvents();

(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await handleSignedIn(session.user);
  } catch (err) {
    console.error('Session check failed:', err);
    $('#auth-status').textContent = 'Could not reach the server. Check your connection and try again.';
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) handleSignedIn(session.user);
    if (event === 'SIGNED_OUT') location.reload();
  });
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

  const { data: allTags } = await sb.from('tags').select('*').order('name');
  tags = allTags || [];

  await loadTasks();

  sb.channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => loadTasks())
    .subscribe();
  sb.channel('tags-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, async () => {
      const { data } = await sb.from('tags').select('*').order('name');
      tags = data || [];
    })
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
let authMode = 'signin';

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
      if (data.session) { $('#auth-status').textContent = ''; await handleSignedIn(data.user); }
      else { $('#auth-status').textContent = 'Account created. Check your email to confirm, then sign in.'; }
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
  $('#quadrant-modal-close').addEventListener('click', () => $('#quadrant-modal').classList.add('hidden'));
  $('#done-modal-close').addEventListener('click', () => $('#done-modal').classList.add('hidden'));
  $('#progress-modal-close').addEventListener('click', () => $('#progress-modal').classList.add('hidden'));
  $('#howto-modal-close').addEventListener('click', () => $('#howto-modal').classList.add('hidden'));
  $('#howto-btn').addEventListener('click', () => $('#howto-modal').classList.remove('hidden'));
  $('#done-toggle-btn').addEventListener('click', openDoneModal);
  $('#progress-btn').addEventListener('click', openProgressModal);

  // Quadrant picker chips
  $all('.qchip').forEach(chip => chip.addEventListener('click', () => {
    selectedQuadrant = { important: chip.dataset.important === 'true', urgent: chip.dataset.urgent === 'true' };
    $all('.qchip').forEach(c => c.classList.toggle('selected', c === chip));
  }));

  // Collapsible sections
  $all('.collapse-toggle').forEach(btn => btn.addEventListener('click', () => {
    const body = $('#' + btn.dataset.target);
    const open = body.classList.contains('hidden');
    body.classList.toggle('hidden', !open);
    btn.classList.toggle('open', open);
  }));

  $('#add-tag-btn').addEventListener('click', addTagInline);
  $('#add-attachment-btn').addEventListener('click', () => { attachmentRows.push({ label: '', url: '' }); renderAttachmentRows(); });
  $('#add-subtask-btn').addEventListener('click', () => { subtaskRows.push({ title: '', assigneeId: '', due: '' }); renderSubtaskRows(); });

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

  // Progress range filter
  $all('.range-btn').forEach(btn => btn.addEventListener('click', () => {
    $all('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('#custom-range-inputs').classList.toggle('hidden', btn.dataset.range !== 'custom');
    if (btn.dataset.range === 'custom') return;
    progressRange = btn.dataset.range === 'all' ? { days: 'all' } : { days: +btn.dataset.range };
    renderProgress();
  }));
  $('#apply-custom-range').addEventListener('click', () => {
    const from = $('#range-from').value, to = $('#range-to').value;
    if (!from || !to) return;
    progressRange = { from: new Date(from), to: new Date(to + 'T23:59:59') };
    renderProgress();
  });

  // Quadrant drop zones (desktop drag-and-drop)
  $all('.card-list').forEach(list => {
    list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drag-over'); });
    list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain');
      const quadrantSection = list.closest('.quadrant');
      if (!taskId || !quadrantSection) return;
      const { important, urgent } = quadrantFields(quadrantSection.dataset.q);
      await sb.from('tasks').update({ important, urgent }).eq('id', taskId);
    });
  });

  $all('.view-all-btn').forEach(btn => btn.addEventListener('click', () => openQuadrantModal(btn.dataset.q)));
}

function quadrantFields(key) {
  return {
    do: { important: true, urgent: true },
    schedule: { important: true, urgent: false },
    delegate: { important: false, urgent: true },
    eliminate: { important: false, urgent: false },
  }[key];
}
const QUADRANT_LABELS = { do: 'Do First', schedule: 'Schedule', delegate: 'Delegate', eliminate: 'Eliminate' };

function populateAssigneeSelect() {
  const html = profiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.id === currentUser.id ? ' (you)' : ''}</option>`).join('');
  $('#f-assignee').innerHTML = html;
}

// ---------------------------------------------------------------
// Derived task properties
// ---------------------------------------------------------------
function quadrantOf(t) {
  if (t.important && t.urgent) return 'do';
  if (t.important && !t.urgent) return 'schedule';
  if (!t.important && t.urgent) return 'delegate';
  return 'eliminate';
}
function isVisible(t) {
  if (t.chain_id && t.chain_status === 'queued') return false;
  if (t.parent_task_id) return false; // subtasks only show inside their parent
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
function tagIcon(id) {
  const t = tags.find(x => x.id === id);
  return t ? t.icon : '';
}
function subtasksOf(id) { return tasks.filter(x => x.parent_task_id === id); }

// ---------------------------------------------------------------
// Render — main dashboard
// ---------------------------------------------------------------
function render() {
  const scoped = tasks.filter(isVisible).filter(t => t.status !== 'done')
    .filter(t => filterMode === 'mine' ? t.assignee_id === currentUser.id : true);
  const quads = { do: [], schedule: [], delegate: [], eliminate: [] };
  scoped.forEach(t => quads[quadrantOf(t)].push(t));

  Object.entries(quads).forEach(([key, list]) => {
    const el = $('#list-' + key);
    const shown = list.slice(0, CARD_LIST_CAP);
    el.innerHTML = shown.length ? shown.map(taskCardHtml).join('') : `<div class="empty-hint">Nothing here.</div>`;
    const viewAllBtn = document.querySelector(`.view-all-btn[data-q="${key}"]`);
    if (list.length > CARD_LIST_CAP) {
      viewAllBtn.classList.remove('hidden');
      viewAllBtn.querySelector('span').textContent = list.length;
    } else {
      viewAllBtn.classList.add('hidden');
    }
  });

  bindCardInteractions();

  const mineDoFirst = tasks.filter(isVisible).filter(t => t.assignee_id === currentUser.id && t.status !== 'done' && quadrantOf(t) === 'do');
  const capEl = $('#cap-warning');
  if (mineDoFirst.length >= DO_FIRST_CAP) {
    capEl.classList.remove('hidden');
    capEl.textContent = `${mineDoFirst.length} in Do First — consider re-triaging one.`;
  } else {
    capEl.classList.add('hidden');
  }

  const doneScoped = tasks.filter(isVisible).filter(t => t.status === 'done')
    .filter(t => filterMode === 'mine' ? t.assignee_id === currentUser.id : true);
  $('#done-count').textContent = doneScoped.length;
}

function bindCardInteractions() {
  $all('.task-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.task-check')) return;
      openDetail(card.dataset.id);
    });
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('card-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('card-dragging'));
  });
  $all('.task-check').forEach(chk => {
    chk.addEventListener('click', (e) => { e.stopPropagation(); toggleDone(chk.dataset.id); });
  });
}

function taskCardHtml(t) {
  const due = t.due_date ? new Date(t.due_date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  const tagChips = (t.tag_ids || []).map(id => `<span class="meta-chip"><span class="tag-chip-icon">${tagIcon(id)}</span></span>`).join('');
  const notesChip = t.notes ? `<span class="meta-chip">📝</span>` : '';
  const attachCount = (t.attachments || []).length;
  const attachChip = attachCount ? `<span class="meta-chip">📎 ${attachCount}</span>` : '';
  const subs = subtasksOf(t.id);
  const subChip = subs.length ? `<span class="meta-chip">✅ ${subs.filter(s => s.status === 'done').length}/${subs.length}</span>` : '';
  return `
    <div class="task-card ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" draggable="true">
      <div class="task-card-top">
        <div class="task-check ${t.status === 'done' ? 'checked' : ''}" data-id="${t.id}">${t.status === 'done' ? '✓' : ''}</div>
        <div class="task-title">${escapeHtml(t.title)}</div>
      </div>
      <div class="task-meta">
        <span>${escapeHtml(profileName(t.assignee_id))}</span>
        ${due ? `<span>${due}</span>` : ''}
        ${t.chain_id ? `<span class="chain-pill">${chainLabel(t)}</span>` : ''}
        ${tagChips}${notesChip}${attachChip}${subChip}
      </div>
    </div>`;
}

async function toggleDone(id) {
  const t = tasks.find(x => x.id === id);
  const newStatus = t.status === 'done' ? 'todo' : 'done';
  const { error } = await sb.from('tasks').update({ status: newStatus }).eq('id', id);
  if (error) alert('Could not update task: ' + error.message);
}

// ---------------------------------------------------------------
// Quadrant "view all" modal
// ---------------------------------------------------------------
function openQuadrantModal(key) {
  const scoped = tasks.filter(isVisible).filter(t => t.status !== 'done')
    .filter(t => filterMode === 'mine' ? t.assignee_id === currentUser.id : true)
    .filter(t => quadrantOf(t) === key);
  $('#quadrant-modal-title').textContent = QUADRANT_LABELS[key];
  $('#quadrant-modal-body').innerHTML = scoped.length ? scoped.map(taskCardHtml).join('') : `<div class="empty-hint">Nothing here.</div>`;
  $all('#quadrant-modal-body .task-card').forEach(card => {
    card.removeAttribute('draggable');
    card.addEventListener('click', (e) => {
      if (e.target.closest('.task-check')) return;
      $('#quadrant-modal').classList.add('hidden');
      openDetail(card.dataset.id);
    });
  });
  $all('#quadrant-modal-body .task-check').forEach(chk => {
    chk.addEventListener('click', async (e) => { e.stopPropagation(); await toggleDone(chk.dataset.id); openQuadrantModal(key); });
  });
  $('#quadrant-modal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Done tasks modal
// ---------------------------------------------------------------
function openDoneModal() {
  const scoped = tasks.filter(isVisible).filter(t => t.status === 'done')
    .filter(t => filterMode === 'mine' ? t.assignee_id === currentUser.id : true)
    .sort((a, b) => new Date(b.completed_at || b.updated_at) - new Date(a.completed_at || a.updated_at));
  $('#done-modal-body').innerHTML = scoped.length ? scoped.map(taskCardHtml).join('') : `<div class="empty-hint">No completed tasks yet.</div>`;
  $all('#done-modal-body .task-card').forEach(card => card.removeAttribute('draggable'));
  $all('#done-modal-body .task-check').forEach(chk => {
    chk.addEventListener('click', async (e) => { e.stopPropagation(); await toggleDone(chk.dataset.id); openDoneModal(); });
  });
  $('#done-modal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Tags
// ---------------------------------------------------------------
function renderTagPicker() {
  $('#tag-picker').innerHTML = tags.map(t => `
    <button type="button" class="tag-pill ${selectedTagIds.has(t.id) ? 'selected' : ''}" data-id="${t.id}">
      <span>${t.icon}</span><span>${escapeHtml(t.name)}</span>
    </button>`).join('');
  $all('#tag-picker .tag-pill').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    selectedTagIds.has(id) ? selectedTagIds.delete(id) : selectedTagIds.add(id);
    renderTagPicker();
  }));
}

async function addTagInline() {
  const icon = $('#new-tag-icon').value.trim() || '🏷️';
  const name = $('#new-tag-name').value.trim();
  if (!name) return;
  const { data, error } = await sb.from('tags').insert({ name, icon, created_by: currentProfile.id }).select().single();
  if (error) { alert('Could not add tag: ' + error.message); return; }
  tags.push(data);
  selectedTagIds.add(data.id);
  $('#new-tag-icon').value = '';
  $('#new-tag-name').value = '';
  renderTagPicker();
}

// ---------------------------------------------------------------
// Attachments (create/edit form)
// ---------------------------------------------------------------
function renderAttachmentRows() {
  const el = $('#attachment-rows');
  el.innerHTML = attachmentRows.map((a, i) => `
    <div class="attachment-row">
      <input type="text" placeholder="Label" value="${escapeHtml(a.label)}" data-field="label" data-idx="${i}" />
      <input type="text" placeholder="https://…" value="${escapeHtml(a.url)}" data-field="url" data-idx="${i}" />
      <button type="button" class="row-remove-btn" data-idx="${i}">✕</button>
    </div>`).join('');
  el.querySelectorAll('input').forEach(inp => inp.addEventListener('input', (e) => {
    attachmentRows[+e.target.dataset.idx][e.target.dataset.field] = e.target.value;
  }));
  el.querySelectorAll('.row-remove-btn').forEach(btn => btn.addEventListener('click', () => {
    attachmentRows.splice(+btn.dataset.idx, 1); renderAttachmentRows();
  }));
}

// ---------------------------------------------------------------
// Subtasks (create form only — existing tasks add via detail view)
// ---------------------------------------------------------------
function renderSubtaskRows() {
  const el = $('#subtask-rows');
  el.innerHTML = subtaskRows.map((s, i) => `
    <div class="subtask-row">
      <input type="text" placeholder="Subtask title" value="${escapeHtml(s.title)}" data-field="title" data-idx="${i}" />
      <select data-field="assigneeId" data-idx="${i}">
        <option value="">Assignee…</option>
        ${profiles.map(p => `<option value="${p.id}" ${p.id === s.assigneeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
      </select>
      <input type="datetime-local" data-field="due" data-idx="${i}" value="${s.due || ''}" />
      <button type="button" class="row-remove-btn" data-idx="${i}">✕</button>
    </div>`).join('');
  el.querySelectorAll('input, select').forEach(inp => inp.addEventListener('input', (e) => {
    subtaskRows[+e.target.dataset.idx][e.target.dataset.field] = e.target.value;
  }));
  el.querySelectorAll('.row-remove-btn').forEach(btn => btn.addEventListener('click', () => {
    subtaskRows.splice(+btn.dataset.idx, 1); renderSubtaskRows();
  }));
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
  $('#f-notes').value = t ? (t.notes || '') : '';
  $('#f-assignee').value = t ? t.assignee_id : currentUser.id;
  $('#f-due').value = t && t.due_date ? toLocalInputValue(t.due_date) : '';

  selectedQuadrant = t ? { important: t.important, urgent: t.urgent } : null;
  $all('.qchip').forEach(c => c.classList.toggle('selected',
    !!t && c.dataset.important === String(t.important) && c.dataset.urgent === String(t.urgent)));

  selectedTagIds = new Set(t ? (t.tag_ids || []) : []);
  renderTagPicker();

  attachmentRows = t ? JSON.parse(JSON.stringify(t.attachments || [])) : [];
  renderAttachmentRows();

  subtaskRows = [];
  renderSubtaskRows();
  // Subtasks can only be added at creation via this form; hide the section on edit
  // (existing tasks add subtasks from the detail view instead).
  $('#sec-subtasks').closest('.collapse-section').classList.toggle('hidden', !!t);

  const chainSection = $('#sec-chain').closest('.collapse-section');
  chainSection.classList.toggle('hidden', !!t);
  $('#f-chain-enable').checked = false;
  $('#chain-builder').classList.add('hidden');
  chainSteps = [];
  renderChainSteps();

  // Collapse all sections closed by default
  $all('.collapse-body').forEach(b => b.classList.add('hidden'));
  $all('.collapse-toggle').forEach(b => b.classList.remove('open'));

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

  el.querySelectorAll('input, select').forEach(inp => inp.addEventListener('input', (e) => {
    chainSteps[+e.target.dataset.idx][e.target.dataset.field] = e.target.value;
  }));
  el.querySelectorAll('.remove-step').forEach(btn => btn.addEventListener('click', () => {
    chainSteps.splice(+btn.dataset.idx, 1); renderChainSteps();
  }));

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
  const notes = $('#f-notes').value.trim();
  const assignee_id = $('#f-assignee').value;
  const due_date = $('#f-due').value ? new Date($('#f-due').value).toISOString() : null;
  const quad = selectedQuadrant || { important: false, urgent: false };
  const tag_ids = Array.from(selectedTagIds);
  const attachments = attachmentRows.filter(a => a.label.trim() && a.url.trim());

  if (editingTaskId) {
    const { error } = await sb.from('tasks').update({
      title, notes, assignee_id, due_date,
      important: quad.important, urgent: quad.urgent,
      tag_ids, attachments,
    }).eq('id', editingTaskId);
    if (error) { alert('Could not update task: ' + error.message); return; }
    closeTaskModal();
    return;
  }

  const useChain = $('#f-chain-enable').checked && chainSteps.length > 0;
  const chain_id = useChain ? crypto.randomUUID() : null;

  const base = {
    title, notes, assignee_id, due_date,
    important: quad.important, urgent: quad.urgent,
    tag_ids, attachments,
    created_by: currentProfile.id,
    chain_id, chain_order: useChain ? 0 : null, chain_status: useChain ? 'active' : null,
  };
  const { data: baseTask, error: baseErr } = await sb.from('tasks').insert(base).select().single();
  if (baseErr) { alert('Could not save task: ' + baseErr.message); return; }

  if (useChain) {
    const rows = chainSteps.filter(s => s.title.trim()).map((s, i) => ({
      title: s.title.trim(), assignee_id: s.assigneeId || null,
      due_date: s.due ? new Date(s.due).toISOString() : null,
      important: quad.important, urgent: quad.urgent,
      created_by: currentProfile.id, chain_id, chain_order: i + 1, chain_status: 'queued',
    }));
    if (rows.length) {
      const { error: chainErr } = await sb.from('tasks').insert(rows);
      if (chainErr) alert('Task saved, but chain steps failed: ' + chainErr.message);
    }
  }

  const validSubtasks = subtaskRows.filter(s => s.title.trim());
  if (validSubtasks.length) {
    const rows = validSubtasks.map(s => ({
      title: s.title.trim(), assignee_id: s.assigneeId || null,
      due_date: s.due ? new Date(s.due).toISOString() : null,
      important: false, urgent: false,
      created_by: currentProfile.id, parent_task_id: baseTask.id,
    }));
    const { error: subErr } = await sb.from('tasks').insert(rows);
    if (subErr) alert('Task saved, but subtasks failed: ' + subErr.message);
  }

  closeTaskModal();
}

async function deleteEditingTask() {
  if (!editingTaskId) return;
  await sb.from('tasks').delete().eq('id', editingTaskId);
  closeTaskModal();
}

// ---------------------------------------------------------------
// Detail modal
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

  const tagHtml = (t.tag_ids || []).length
    ? `<div class="d-row"><div class="d-label">TAGS</div>${(t.tag_ids || []).map(id => {
        const tg = tags.find(x => x.id === id); return tg ? `<span class="meta-chip">${tg.icon} ${escapeHtml(tg.name)}</span> ` : '';
      }).join('')}</div>` : '';

  const attachHtml = (t.attachments || []).length
    ? `<div class="d-row"><div class="d-label">ATTACHMENTS</div>${(t.attachments || [])
        .map(a => `<div>📎 <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.label)}</a></div>`).join('')}</div>` : '';

  const subs = subtasksOf(t.id);
  const subtaskHtml = `<div class="d-row"><div class="d-label">SUBTASKS</div>
    ${subs.map(s => `
      <div class="subtask-checklist-item">
        <div class="task-check ${s.status === 'done' ? 'checked' : ''}" data-sub-id="${s.id}">${s.status === 'done' ? '✓' : ''}</div>
        <span>${escapeHtml(s.title)}</span>
        <span class="subtask-meta">${escapeHtml(profileName(s.assignee_id))}${s.due_date ? ' · ' + new Date(s.due_date).toLocaleDateString() : ''}</span>
      </div>`).join('')}
    <div class="subtask-row" id="inline-add-subtask">
      <input type="text" placeholder="New subtask…" id="inline-sub-title" />
      <select id="inline-sub-assignee">${profiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
      <input type="datetime-local" id="inline-sub-due" />
      <button type="button" class="row-remove-btn" id="inline-sub-add" title="Add">+</button>
    </div>
  </div>`;

  const moveButtons = Object.keys(QUADRANT_LABELS).map(key =>
    `<button type="button" class="move-to-btn" data-move="${key}">${QUADRANT_LABELS[key]}</button>`).join('');

  $('#detail-body').innerHTML = `
    <div class="d-row"><div class="d-label">ASSIGNEE</div>${escapeHtml(profileName(t.assignee_id))}</div>
    ${t.notes ? `<div class="d-row"><div class="d-label">NOTES</div>${escapeHtml(t.notes)}</div>` : ''}
    ${t.due_date ? `<div class="d-row"><div class="d-label">DUE</div>${new Date(t.due_date).toLocaleString()}</div>` : ''}
    <div class="d-row"><div class="d-label">STATUS</div>${t.status}</div>
    ${tagHtml}${attachHtml}${chainHtml}
    ${!t.parent_task_id ? subtaskHtml : ''}
    <div class="d-row"><div class="d-label">MOVE TO</div><div class="move-to-row">${moveButtons}</div></div>
    <div class="modal-actions">
      <button type="button" class="ghost-btn" id="detail-edit-btn">Edit</button>
      <button type="button" class="primary-btn" id="detail-toggle-btn">${t.status === 'done' ? 'Mark not done' : 'Mark done'}</button>
    </div>`;

  $('#detail-edit-btn').addEventListener('click', () => { $('#detail-modal').classList.add('hidden'); openTaskModal(t.id); });
  $('#detail-toggle-btn').addEventListener('click', async () => { await toggleDone(t.id); $('#detail-modal').classList.add('hidden'); });

  $all('.move-to-btn').forEach(btn => btn.addEventListener('click', async () => {
    const { important, urgent } = quadrantFields(btn.dataset.move);
    await sb.from('tasks').update({ important, urgent }).eq('id', t.id);
    $('#detail-modal').classList.add('hidden');
  }));

  $all('[data-sub-id]').forEach(chk => chk.addEventListener('click', async () => {
    const sub = tasks.find(x => x.id === chk.dataset.subId);
    await sb.from('tasks').update({ status: sub.status === 'done' ? 'todo' : 'done' }).eq('id', sub.id);
    openDetail(id);
  }));

  const addBtn = $('#inline-sub-add');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const title = $('#inline-sub-title').value.trim();
    if (!title) return;
    const assignee_id = $('#inline-sub-assignee').value;
    const dueVal = $('#inline-sub-due').value;
    const { error } = await sb.from('tasks').insert({
      title, assignee_id, due_date: dueVal ? new Date(dueVal).toISOString() : null,
      important: false, urgent: false, created_by: currentProfile.id, parent_task_id: t.id,
    });
    if (error) { alert('Could not add subtask: ' + error.message); return; }
    openDetail(id);
  });

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
// My progress — heatmap + quadrant completion donuts
// ---------------------------------------------------------------
function openProgressModal() {
  progressRange = { days: 7 };
  $all('.range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === '7'));
  $('#custom-range-inputs').classList.add('hidden');
  renderProgress();
  $('#progress-modal').classList.remove('hidden');
}

function rangeToDates() {
  const to = new Date();
  if (progressRange.from) return { from: progressRange.from, to: progressRange.to };
  if (progressRange.days === 'all') {
    const earliest = tasks.reduce((min, t) => {
      const d = new Date(t.created_at);
      return d < min ? d : min;
    }, new Date());
    return { from: earliest, to };
  }
  const from = new Date();
  from.setDate(from.getDate() - progressRange.days);
  return { from, to };
}

function renderProgress() {
  const { from, to } = rangeToDates();
  renderHeatmap(from, to);
  renderDonuts(from, to);
}

function renderHeatmap(from, to) {
  const dayCounts = {};
  tasks.filter(t => t.assignee_id === currentUser.id && t.completed_at).forEach(t => {
    const d = new Date(t.completed_at);
    if (d < from || d > to) return;
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });

  // Align to the Sunday on/before `from`, so weeks form clean columns.
  const start = new Date(from);
  start.setDate(start.getDate() - start.getDay());
  const days = [];
  for (let d = new Date(start); d <= to; d.setDate(d.getDate() + 1)) days.push(new Date(d));

  const max = Math.max(1, ...Object.values(dayCounts));
  const bucket = (n) => n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
  const shades = ['var(--line)', '#D9C9BE', '#C79A7E', '#B3432B', '#7A2D1C'];

  const cells = days.map(d => {
    const key = d.toISOString().slice(0, 10);
    const n = dayCounts[key] || 0;
    const inRange = d >= from && d <= to;
    const color = inRange ? shades[bucket(n)] : 'transparent';
    return `<div class="heatmap-cell" title="${key}: ${n} completed" style="background:${color}"></div>`;
  }).join('');

  $('#heatmap-wrap').innerHTML = `
    <div class="heatmap-grid">${cells}</div>
    <div class="heatmap-legend">Less ${shades.map(s => `<span class="heatmap-cell" style="background:${s}"></span>`).join('')} More</div>`;
}

function renderDonuts(from, to) {
  const mine = tasks.filter(t => t.assignee_id === currentUser.id && !t.parent_task_id
    && new Date(t.created_at) >= from && new Date(t.created_at) <= to);
  const buckets = { do: [], schedule: [], delegate: [], eliminate: [] };
  mine.forEach(t => buckets[quadrantOf(t)].push(t));

  $('#donut-grid').innerHTML = Object.entries(buckets).map(([key, list]) => {
    const done = list.filter(t => t.status === 'done').length;
    const pct = list.length ? Math.round((done / list.length) * 100) : 0;
    return `<div class="donut-card">${donutSvg(pct, quadrantAccent(key))}
      <div class="donut-pct">${pct}%</div>
      <div class="donut-label">${QUADRANT_LABELS[key]} (${done}/${list.length})</div></div>`;
  }).join('');
}

function quadrantAccent(key) {
  return { do: '#B3432B', schedule: '#2B5F8A', delegate: '#A6791F', eliminate: '#6B6660' }[key];
}

function donutSvg(pct, color) {
  const r = 34, c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return `<svg width="90" height="90" viewBox="0 0 90 90">
    <circle cx="45" cy="45" r="${r}" fill="none" stroke="var(--line)" stroke-width="9"/>
    <circle cx="45" cy="45" r="${r}" fill="none" stroke="${color}" stroke-width="9"
      stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"
      transform="rotate(-90 45 45)"/>
  </svg>`;
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
