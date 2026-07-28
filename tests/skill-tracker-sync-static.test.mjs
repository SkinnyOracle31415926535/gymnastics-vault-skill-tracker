import assert from 'node:assert/strict';
import fs from 'node:fs';

const sync = fs.readFileSync(new URL('../skill-tracker-sync.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../skill-tracker-store.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const combined = `${store}\n${sync}`;

const checks = [
  ['uses the exact Skill Tracker app scope', () => {
    assert.match(sync, /const APP_ID = 'skill-tracker'/);
    assert.match(sync, /scope: APP_ID/);
    assert.match(sync, /appId: APP_ID/);
  }],
  ['registers preferences plus per-class and per-day records', () => {
    assert.match(sync, /collection: 'preferences'/);
    assert.match(sync, /recordId: 'current'/);
    assert.match(sync, /collection: 'classes'/);
    assert.match(sync, /collection: 'saved-days'/);
    assert.match(sync, /registerCollection\(classesAdapter\)/);
    assert.match(sync, /registerCollection\(savedDaysAdapter\)/);
  }],
  ['requires exact raw backup before a zero-write preview', () => {
    const handler = sync.slice(sync.indexOf("previewButton.addEventListener"));
    assert.ok(handler.indexOf('downloadRawBackup()') < handler.indexOf('previewMigration'));
    assert.match(sync, /writesPerformed !== 0/);
    assert.match(sync, /Preview confirmed: 0 writes performed/);
  }],
  ['hard-blocks first-device migration when any remote record exists', () => {
    assert.match(sync, /previewResult\.preview\.remoteCount > 0/);
    assert.match(sync, /First-device migration is blocked/);
  }],
  ['hard-blocks and visibly explains orphaned synchronized records', () => {
    assert.match(sync, /previewResult\.preview\.orphanedCount > 0/);
    assert.match(sync, /orphaned synchronized record/);
    assert.match(sync, /Migration is blocked because orphaned synchronized records/);
  }],
  ['supports explicit conflicts, disconnect, and device reset', () => {
    assert.match(sync, /listConflicts\(\)/);
    assert.match(sync, /resolveConflict/);
    assert.match(sync, /client\.disconnect\(\)/);
    assert.match(sync, /client\.resetDevice\(\)/);
  }],
  ['keeps local writes local-first and stages only explicit change records', () => {
    assert.match(html, /await skillTrackerStore\.writeLocal\(key, value, \{ source: "local" \}\)/);
    assert.match(sync, /preferencesHandle\.save/);
    assert.match(sync, /classesHandle\.save/);
    assert.match(sync, /classesHandle\.remove/);
    assert.match(sync, /daysHandle\.save/);
    assert.match(sync, /daysHandle\.remove/);
    assert.match(sync, /verifyCurrentPreferences/);
    assert.match(sync, /verifyCurrentClassRecord/);
    assert.match(sync, /verifyCurrentDayRecord/);
  }],
  ['serializes local staging and defers remote application until editors are idle', () => {
    assert.match(sync, /const pendingStages = new Map/);
    assert.match(sync, /enqueueLocalStage/);
    assert.match(sync, /await whenStagingSettled\(\)/);
    assert.match(sync, /await waitForEditorIdle\(\)/);
    assert.match(sync, /currentRevision\.local !== requestedRevision\.local/);
    assert.match(html, /whenEditorIdle: whenTrackerEditorIdle/);
    assert.doesNotMatch(sync, /Close it before accepting synchronized data/);
  }],
  ['uses one aggregate lock and exact historical recovery detection', () => {
    assert.match(store, /const LOCK_NAME = 'skill-tracker:aggregate-state-v1'/);
    assert.match(store, /normalizeRecoverable/);
    assert.match(store, /workspace-2026-07-14/);
    assert.match(store, /workspace-2026-07-23/);
    assert.match(store, /saved-days-2026-07-14-through-2026-07-23/);
    assert.match(store, /not a known Skill Tracker format/);
  }],
  ['loads the strict store before the app and the public client before the adapter', () => {
    const storeIndex = html.indexOf('skill-tracker-store.js?v=1');
    const mainIndex = html.indexOf('const appTitle = "Skill Tracker"');
    const clientIndex = html.indexOf('ryan-app-sync.js');
    const syncIndex = html.indexOf('skill-tracker-sync.js?v=1');
    assert.ok(storeIndex >= 0 && storeIndex < mainIndex);
    assert.ok(clientIndex > mainIndex && clientIndex < syncIndex);
  }],
  ['does not patch native storage, clear storage, or enumerate browser keys', () => {
    assert.doesNotMatch(combined, /Storage\.prototype/);
    assert.doesNotMatch(combined, /localStorage\.clear\s*\(/);
    assert.doesNotMatch(combined, /Object\.keys\s*\(\s*(?:window\.)?localStorage/);
    assert.doesNotMatch(combined, /for\s*\([^)]*localStorage\.length/);
  }],
  ['does not register a theme or expose legacy stored values', () => {
    assert.doesNotMatch(combined, /collection:\s*['"]settings['"]/);
    assert.doesNotMatch(combined, /recordId:\s*['"]theme['"]/);
    assert.doesNotMatch(store, /rings-floor-form|mushroom-circle-tracker/);
  }],
  ['contains no embedded authorization header, bearer token, or secret', () => {
    assert.doesNotMatch(combined, /Authorization\s*:/i);
    assert.doesNotMatch(combined, /Bearer\s+[A-Za-z0-9._-]+/);
    assert.doesNotMatch(combined, /SITES_BYPASS_TOKEN|OPENAI_API_KEY|api[_-]?key/i);
  }],
];

let passed = 0;
for (const [name, check] of checks) {
  check();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}
process.stdout.write(`1..${passed}\n`);
