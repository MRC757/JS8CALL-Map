// Group alerts: shown over the map in the JS8Stat alert style, newest first,
// with previous/next, delete and close.

import { escHtml } from './util.js';
import { openDraft, isDraft } from './cs-forms.js';
import { on, recordsOf, ALERT_COLORS, fmtFull, lines, confirmDialog, request, playSound } from './js8stat.js';

let list  = [];   // alerts passing the filters, newest first
let index = 0;
let open  = false;

const el = () => document.getElementById('cs-alert');

function refreshList() {
  list = recordsOf('alert');
  if (index >= list.length) index = Math.max(0, list.length - 1);
}

function render() {
  const box = el();
  if (!open || !list.length) { box.classList.add('hidden'); open = open && list.length > 0; return; }
  const r = list[index];
  const [name, bg, fg] = ALERT_COLORS[r.color] || ALERT_COLORS[1];
  box.innerHTML = `
    <div class="cs-alert-head" style="background:${bg};color:${fg}">
      <span class="cs-alert-level">${escHtml(name.toUpperCase())} ALERT</span>
      <span class="cs-alert-pos">${index + 1} of ${list.length}</span>
    </div>
    <div class="cs-alert-title">${escHtml(r.title)}</div>
    <div class="cs-alert-message">${lines(r.message).map(escHtml).join('<br>')}</div>
    <div class="cs-alert-meta">${escHtml(r.from)} → ${escHtml(r.target || 'all')} · ${escHtml(fmtFull(r.utc))} UTC</div>
    <div class="cs-alert-nav">
      <button type="button" class="cs-glass" data-act="prev" ${index >= list.length - 1 ? 'disabled' : ''} aria-label="Older alert">&#9664; Older</button>
      <button type="button" class="cs-glass" data-act="next" ${index === 0 ? 'disabled' : ''} aria-label="Newer alert">Newer &#9654;</button>
      <span class="cs-spacer"></span>
      ${isDraft(r) ? '<button type="button" class="cs-glass" data-act="edit" title="Reopen this saved draft to change or transmit it">Edit / Send</button>' : ''}
      <button type="button" class="cs-glass cs-glass-red" data-act="delete">Delete</button>
      <button type="button" class="cs-glass" data-act="close">Close</button>
    </div>`;
  box.classList.remove('hidden');
}

/** Open the alert viewer on the newest alert. */
export function showAlerts() {
  refreshList();
  index = 0;
  open = true;
  render();
  return list.length;
}

export function initAlerts() {
  el().addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'prev') index = Math.min(list.length - 1, index + 1);
    if (act === 'next') index = Math.max(0, index - 1);
    if (act === 'close') open = false;
    if (act === 'edit') { openDraft(list[index]); return; }
    if (act === 'delete') {
      const r = list[index];
      if (r && await confirmDialog({ title: 'Delete alert', html: '<p>Delete this alert from the map?</p>', yes: 'Delete', yesColor: 'red' })) {
        await request({ type: 'CS_DELETE', id: r.id }).catch(() => {});
      }
      return;
    }
    render();
  });

  on('reset', () => { refreshList(); render(); });
  on('remove', () => { refreshList(); render(); });
  on('settings', () => { refreshList(); render(); });
  on('record', ({ record, isNew }) => {
    if (record.kind !== 'alert') return;
    refreshList();
    // A new alert that passes the filters pops up immediately.
    if (isNew && list.some(r => r.id === record.id)) {
      index = list.findIndex(r => r.id === record.id);
      open = true;
      if (record.source === 'rf') playSound('alert');
    }
    render();
  });
  refreshList();
}

export const alertCount = () => { refreshList(); return list.length; };
