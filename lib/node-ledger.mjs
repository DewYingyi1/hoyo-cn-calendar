import { calendarNodes, describeEvent, inCalendarWindow, nodeTitle, nodeUid, PRESENTATION_REVISION, renderCalendar, validateEvent } from './calendar.mjs';

const DAY = 86400000;
export const NODE_LEDGER_VERSION = 1;
export const TOMBSTONE_DAYS = 120;
export const nodeKey = (eventId, suffix, mode) => `${eventId}:${suffix}:${mode}`;

// Ledger sequences are source/base revisions; renderCalendar still adds presentation offset 2.
// Keep retired records permanently for UID/revision memory, but publish their tombstones for
// at least 120 days from retirement (not from the original DTSTART/DTEND).
function validNow(now) {
  if (!Number.isFinite(Date.parse(now))) throw new Error('节点账本缺有效构建时间');
}
function canonicalId(id, aliases) {
  const parts = id.split(':');
  let prefix = parts.slice(0, 3).join(':');
  const seen = new Set();
  while (aliases[prefix] && aliases[prefix] !== prefix) {
    if (seen.has(prefix)) throw new Error(`循环事件 alias：${id}`);
    seen.add(prefix);
    prefix = aliases[prefix];
  }
  return prefix + (parts.length > 3 ? ':' + parts.slice(3).join(':') : '');
}
function content(event, node) {
  return JSON.stringify([event.game, event.category, nodeTitle(event, node), describeEvent(event, node), event.url, node.start, node.end ?? new Date(Date.parse(node.start) + 15 * 60000).toISOString()]);
}
function later(first, second) { return Date.parse(first) >= Date.parse(second) ? first : second; }
function publishedItems(text) {
  if (typeof text !== 'string' || !text.startsWith('BEGIN:VCALENDAR')) throw new Error('基线缺真实公开ICS');
  const items = new Map();
  for (const match of text.replace(/\r?\n[ \t]/g, '').matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g)) {
    const properties = Object.fromEntries(match[1].split(/\r?\n/).map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1)];
    }));
    const uid = properties.UID;
    if (!uid || items.has(uid)) throw new Error(`基线ICS重复或缺UID：${uid}`);
    items.set(uid, properties);
  }
  return items;
}
function fromUtc(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value ?? '')) throw new Error(`基线ICS时间无效：${value}`);
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error(`基线ICS时间无效：${value}`);
  return iso;
}
function record(event, node, mode, now, uidAliases) {
  const uid = uidAliases[nodeKey(event.id, node.suffix, mode)] ?? nodeUid(event.id, node.suffix, mode);
  return { uid, eventId: event.id, mode, event: structuredClone(event), node: { ...node }, sequence: event.sequence, modified: event.modified, publishedAt: now, state: event.cancelled ? 'retired' : 'active', ...(event.cancelled ? { retiredAt: now, reason: 'cancelled' } : {}) };
}
export function validateNodeLedger(ledger) {
  if (ledger?.version !== NODE_LEDGER_VERSION || !Array.isArray(ledger.nodes)) throw new Error('不支持的已发布节点账本');
  const uids = new Set();
  for (const entry of ledger.nodes) {
    validateEvent(entry.event);
    if (typeof entry.uid !== 'string' || !entry.uid || /[\r\n]/.test(entry.uid) || uids.has(entry.uid)) throw new Error(`重复或无效账本 UID：${entry.uid}`);
    if (entry.eventId !== entry.event.id || !['nodes', 'timeline'].includes(entry.mode) || !['start', 'end', 'timeline'].includes(entry.node?.suffix) || !['active', 'retired'].includes(entry.state) || !Number.isInteger(entry.sequence) || entry.sequence < 0 || !Number.isFinite(Date.parse(entry.modified)) || !Number.isFinite(Date.parse(entry.node.start)) || (entry.node.end != null && !Number.isFinite(Date.parse(entry.node.end))) || !Number.isFinite(Date.parse(entry.publishedAt)) || (entry.state === 'retired' && !Number.isFinite(Date.parse(entry.retiredAt)))) throw new Error(`无效账本节点：${entry.uid}`);
    uids.add(entry.uid);
  }
}

/** Initialize from the last published event baseline, BEFORE applying new edits.
 * now must be that baseline's generatedAt to reproduce its publication window.
 * uidAliases maps nodeKey(eventId, suffix, mode) to an already published UID.
 * publicBaseline: true is required for site/data/events.json, whose notes already
 * contain reader-facing text rather than the source/audit notes used by readerNotes.
 * calendars: { nodes: realPublishedIcs, timeline: realPublishedTimelineIcs } gates
 * initialization on actual published UIDs, not a guessed event/window baseline.
 * Source-ID aliases are passed to reconcileNodeLedger; initialization never rehashes old IDs.
 */
export function initializeNodeLedger(events, { now, uidAliases = {}, publicBaseline = false, calendars } = {}) {
  validNow(now);
  const ledger = { version: NODE_LEDGER_VERSION, nodes: [] };
  const published = calendars === undefined ? null : { nodes: publishedItems(calendars.nodes), timeline: publishedItems(calendars.timeline) };
  const ids = new Set();
  for (const original of events) {
    const event = publicBaseline ? { ...original, displayNotes: original.displayNotes ?? original.notes ?? '' } : original;
    validateEvent(event);
    if (ids.has(event.id)) throw new Error(`重复基线事件：${event.id}`);
    ids.add(event.id);
    if (!published && !inCalendarWindow(event, now)) continue;
    for (const mode of ['nodes', 'timeline']) {
      for (const node of calendarNodes(event, mode)) {
        const entry = record(event, node, mode, now, uidAliases);
        if (published) {
          const item = published[mode].get(entry.uid);
          if (!item) continue;
          entry.sequence = Number(item.SEQUENCE) - PRESENTATION_REVISION;
          entry.modified = fromUtc(item['LAST-MODIFIED'] ?? item.DTSTAMP);
          const start = fromUtc(item.DTSTART);
          const end = fromUtc(item.DTEND);
          if (Date.parse(start) !== Date.parse(node.start) || Date.parse(end) !== Date.parse(node.end ?? new Date(Date.parse(node.start) + 15 * 60000).toISOString())) throw new Error(`公开ICS与事件基线不一致：${entry.uid}`);
          const expected = publishedItems(renderCalendar([], { name: '基线校验', mode, now, publishedNodes: [{ event, node: { ...node, uid: entry.uid, sequence: entry.sequence, modified: entry.modified } }] })).get(entry.uid);
          for (const property of ['SUMMARY', 'DESCRIPTION', 'URL', 'CATEGORIES', 'STATUS']) {
            if (item[property] !== expected[property]) throw new Error(`公开ICS与事件基线内容不一致：${entry.uid} ${property}`);
          }
          if (item.STATUS === 'CANCELLED') Object.assign(entry, { state: 'retired', retiredAt: now, reason: 'cancelled' });
          published[mode].delete(entry.uid);
        }
        ledger.nodes.push(entry);
      }
    }
  }
  if (published && (published.nodes.size || published.timeline.size)) throw new Error('公开ICS含未映射UID；请使用改动前事件基线或提供uidAliases');
  validateNodeLedger(ledger);
  return ledger;
}

/** Pure reconciliation over the complete, merged effective event set, NOT a fetch result.
 * Missing source responses must already have been retained by mergeEvents.
 * Returns { ledger, publishedNodes: { nodes, timeline } }; neither input is mutated.
 */
export function reconcileNodeLedger(previous, events, { now, aliases = {}, uidAliases = {}, explicitRemovals = [], tombstoneDays = TOMBSTONE_DAYS } = {}) {
  validNow(now);
  validateNodeLedger(previous);
  if (!Number.isFinite(tombstoneDays) || tombstoneDays < TOMBSTONE_DAYS) throw new Error('取消墓碑保留窗口不得少于120天');
  const ledger = structuredClone(previous);
  const used = new Set();
  const ids = new Set();
  const processed = new Set();
  const removals = new Set(explicitRemovals.map(id => canonicalId(id, aliases)));
  const ordered = { nodes: [], timeline: [] };
  for (const event of events) {
    validateEvent(event);
    const identity = canonicalId(event.id, aliases);
    if (ids.has(identity)) throw new Error(`重复 canonical 事件：${identity}`);
    ids.add(identity);
    processed.add(identity);
    for (const mode of ['nodes', 'timeline']) {
      const candidates = ledger.nodes.filter(entry => entry.mode === mode && canonicalId(entry.eventId, aliases) === identity);
      for (const node of calendarNodes(event, mode)) {
        const explicitUid = uidAliases[nodeKey(event.id, node.suffix, mode)];
        // Exact IDs/suffixes win; timeline is one evolving item, even when its shape changes.
        const matches = candidates.filter(entry => !used.has(entry.uid) && (explicitUid ? entry.uid === explicitUid : entry.node.suffix === node.suffix || mode === 'timeline'));
        matches.sort((a, b) => Number(b.eventId === event.id) - Number(a.eventId === event.id) || Number(b.state === 'active') - Number(a.state === 'active'));
        let entry = explicitUid ? ledger.nodes.find(item => item.uid === explicitUid && item.mode === mode && !used.has(item.uid)) : matches[0];
        if (!entry) {
          // A cancellation is not a new event. Never backfill already-ended events
          // that were absent from the actual publication baseline.
          if (event.cancelled || Date.parse(event.end ?? event.start) < Date.parse(now) || !inCalendarWindow(event, now)) continue;
          entry = record(event, node, mode, now, uidAliases);
          ledger.nodes.push(entry);
        } else if (!event.cancelled) {
          const changed = entry.state === 'retired' || content(entry.event, entry.node) !== content(event, node);
          const sequence = Math.max(event.sequence, entry.sequence + Number(changed));
          const modified = changed && Date.parse(event.modified) <= Date.parse(entry.modified) ? later(now, entry.modified) : later(event.modified, entry.modified);
          Object.assign(entry, { eventId: event.id, event: structuredClone(event), node: { ...node }, sequence, modified, state: 'active' });
          delete entry.retiredAt;
          delete entry.reason;
        }
        used.add(entry.uid);
        if (event.cancelled) retire(entry, now, 'cancelled', event.sequence);
        if (entry.state === 'active' && inCalendarWindow(event, now)) ordered[mode].push(entry);
      }
    }
  }
  // Missing input is not proof of withdrawal: sources and historical data may be cleaned up.
  // Retire only nodes removed from an event that is still present, or whole events whose
  // removal intent was supplied explicitly by the build layer (suppression/splitting).
  for (const entry of ledger.nodes) {
    if (used.has(entry.uid)) continue;
    const identity = canonicalId(entry.eventId, aliases);
    if (processed.has(identity)) retire(entry, now, 'node-removed');
    else if (removals.has(identity)) retire(entry, now, 'removed');
  }
  validateNodeLedger(ledger);
  const publishedNodes = {};
  for (const mode of ['nodes', 'timeline']) {
    const tombstones = ledger.nodes.filter(entry => entry.mode === mode && entry.state === 'retired' && Date.parse(now) - Date.parse(entry.retiredAt) <= tombstoneDays * DAY);
    publishedNodes[mode] = [...ordered[mode], ...tombstones].map(entry => ({ event: structuredClone(entry.event), node: { ...entry.node, uid: entry.uid, sequence: entry.sequence, modified: entry.modified, cancelled: entry.state === 'retired' } }));
  }
  return { ledger, publishedNodes };
}

function retire(entry, now, reason, sequence = 0) {
  if (entry.state === 'retired') return;
  entry.sequence = Math.max(entry.sequence + 1, sequence);
  entry.modified = later(now, entry.modified);
  entry.state = 'retired';
  entry.retiredAt = now;
  entry.reason = reason;
}
