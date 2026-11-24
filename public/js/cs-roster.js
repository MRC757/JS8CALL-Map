// Group roster: for each group, which stations reported, which were heard
// without reporting, and which have gone silent — so a net control can see who
// is missing as well as what came in.

import { escHtml } from './util.js';
import { cs, on, knownGroups, groupList, baseCall, fmtShort, STATUS_NAMES, openDialog } from './js8stat.js';

const WINDOWS = [[6, '6 hours'], [12, '12 hours'], [24, '24 hours']];
const KIND_LABEL = { statrep: 'Status report', incident: 'Incident', alert: 'Alert', message: 'Message', traffic: 'Other traffic' };

const ago = (ms, now) => {
  const m = Math.round((now - ms) / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Groups worth offering: chosen in the filter first, then any heard. */
function rosterGroups() {
  const set = new Set([...groupList(), ...Object.keys(cs.activity), ...knownGroups()]);
  return [...set].filter(g => g.startsWith('@'));
}

/**
 * Members of a group with their latest activity and report.
 * A station counts as a member if it was heard on the group, or sent it a
 * record, at any time JS8Stat still remembers (records are kept for keepDays).
 */
export function rosterFor(group, hours, now = Date.now()) {
  const since = now - hours * 3600_000;
  const members = new Map();
  const get = call => {
    if (!members.has(call)) members.set(call, { call, lastHeard: 0, lastKind: '', report: null });
    return members.get(call);
  };
  for (const [call, a] of Object.entries(cs.activity[group] || {})) {
    const m = get(call);
    if (a.utc > m.lastHeard) { m.lastHeard = a.utc; m.lastKind = a.kind; }
  }
  for (const r of cs.records.values()) {
    if (r.target !== group || r.source !== 'rf') continue;
    const m = get(baseCall(r.from));
    if (r.utc > m.lastHeard) { m.lastHeard = r.utc; m.lastKind = r.kind; }
    if ((r.kind === 'statrep' || r.kind === 'incident') && (!m.report || r.utc > m.report.utc)) m.report = r;
  }
  const rows = [...members.values()].map(m => ({
    ...m,
    status: m.report && m.report.utc >= since ? 'reported' : m.lastHeard >= since ? 'active' : 'silent',
  }));
  const order = { reported: 0, active: 1, silent: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.lastHeard - a.lastHeard);
  return rows;
}

function rowHtml(m, now) {
  const st = m.report ? (m.report.kind === 'incident' ? m.report.type : m.report.status?.[0]) : '';
  const chip = st ? `<span class="cs-chip cs-st-${escHtml(st)}" title="${escHtml(STATUS_NAMES[st] || '')}"></span>` : '';
  const label = { reported: 'Reported', active: 'Heard, no report', silent: 'Silent' }[m.status];
  return `<tr class="cs-roster-${m.status}">
    <td class="cs-bold">${escHtml(m.call)}</td>
    <td>${m.lastHeard ? `${escHtml(fmtShort(m.lastHeard))} <span class="cs-hint">(${ago(m.lastHeard, now)})</span>` : '—'}</td>
    <td>${escHtml(KIND_LABEL[m.lastKind] || '')}</td>
    <td>${m.report ? `${chip} ${escHtml(m.report.srId || '')} · ${escHtml(fmtShort(m.report.utc))}` : '—'}</td>
    <td class="cs-roster-status">${label}</td>
  </tr>`;
}

export function openRoster() {
  const groups = rosterGroups();
  let group = groups[0] || '';
  let hours = 12;
  const dlg = openDialog({
    title: 'Group Roster',
    width: 760,
    body: `
      <div class="cs-form-row">
        <label class="cs-field"><span>Group</span>
          <select name="group">${groups.map(g => `<option>${escHtml(g)}</option>`).join('') || '<option value="">(no groups heard yet)</option>'}</select></label>
        <label class="cs-field"><span>Period</span>
          <select name="hours">${WINDOWS.map(([h, l]) => `<option value="${h}"${h === hours ? ' selected' : ''}>Last ${l}</option>`).join('')}</select></label>
      </div>
      <div class="cs-roster-warning" role="alert" hidden></div>
      <p class="cs-roster-summary"></p>
      <div class="cs-roster-wrap"><table class="cs-table cs-roster">
        <thead><tr><th>Station</th><th>Last heard on group</th><th>Last traffic</th><th>Last report</th><th>Status</th></tr></thead>
        <tbody></tbody></table></div>
      <p class="cs-hint">"Heard, no report" means the station was active on the group but sent no status report in the period.
        "Silent" stations were heard on the group earlier (within ${cs.keepDays} days) but not in this period.</p>`,
    buttons: [{ label: 'Close', color: 'gray' }],
  });
  const root = dlg.body;

  const render = () => {
    const now = Date.now();
    const rows = group ? rosterFor(group, hours, now) : [];
    const n = s => rows.filter(r => r.status === s).length;
    root.querySelector('.cs-roster-summary').textContent = group
      ? `${rows.length} station${rows.length === 1 ? '' : 's'} on ${group}: ${n('reported')} reported, ${n('active')} heard without a report, ${n('silent')} silent in the last ${hours} h.`
      : 'No group traffic heard yet.';
    root.querySelector('tbody').innerHTML = rows.map(r => rowHtml(r, now)).join('')
      || `<tr class="cs-empty"><td colspan="5">Nothing heard on ${escHtml(group || 'any group')} yet.</td></tr>`;
    const warn = root.querySelector('.cs-roster-warning');
    warn.hidden = !cs.groupWarnings.includes(group);
    warn.textContent = `Only partial messages are arriving for ${group}. It is probably not one of your groups in JS8CALL, ` +
      'so whole messages for it are not passed on. Add it to your group memberships in JS8CALL\'s settings.';
  };
  root.querySelector('[name="group"]').addEventListener('change', e => { group = e.target.value; render(); });
  root.querySelector('[name="hours"]').addEventListener('change', e => { hours = Number(e.target.value); render(); });

  // Keep it current while it is open
  const live = () => { if (dlg.el.isConnected) render(); };
  on('activity', live);
  on('record', live);
  on('groups', live);
  render();
  return dlg;
}
