import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../skill-tracker-store.js', import.meta.url), 'utf8');

class LocalStorageMock {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

class CustomEventMock {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

const makeRuntime = () => {
  const listeners = new Map();
  const localStorage = new LocalStorageMock();
  const lockCalls = [];
  const window = {
    localStorage,
    navigator: {
      locks: {
        request: (name, options, callback) => {
          lockCalls.push({ name, options });
          return Promise.resolve().then(callback);
        },
      },
    },
    crypto: webcrypto,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    localStorage,
    navigator: window.navigator,
    crypto: webcrypto,
    CustomEvent: CustomEventMock,
    TextEncoder,
    Uint8Array,
    Date,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Error,
    RegExp,
    Number,
    String,
    Boolean,
  });
  vm.runInContext(source, context, { filename: 'skill-tracker-store.js' });
  return { window, localStorage, store: window.SkillTrackerStore, lockCalls };
};

const row = (values = ['-']) => ({
  event: 'floor',
  sheet: 'sheet-1',
  skill: 'Handstand',
  goal: '20',
  values,
});

const workspace = () => ({
  activeClassId: 'level-3',
  settingsLocked: false,
  focusViewMode: 'custom',
  removedBuiltInClasses: [],
  classes: {
    'level-3': {
      name: 'Level 3',
      athletes: ['Ariel'],
      hiddenAthletes: [],
      hiddenSkillKeys: [],
      removedRows: [],
      removedSheets: [],
      customSheets: [],
      sheetLabels: {},
      data: {
        date: '2026-07-28',
        rows: [row()],
      },
    },
  },
});

const savedDay = (date = '2026-07-28') => ({
  classId: 'level-3',
  className: 'Level 3',
  date,
  label: 'Jul 28, 2026 - Level 3',
  savedAt: '2026-07-28T12:00:00.000Z',
  athletes: ['Ariel'],
  hiddenAthletes: [],
  hiddenSkillKeys: [],
  customSheets: [],
  sheetLabels: {},
  rows: [row()],
});

const savedDays = (date = '2026-07-28') => ({
  classes: {
    'level-3': {
      [date]: savedDay(date),
    },
  },
});

let passed = 0;
const test = async (name, callback) => {
  await callback();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
};

await test('accepts canonical app, preference, class, and saved-day schemas', async () => {
  const { store } = makeRuntime();
  const state = workspace();
  assert.equal(store.isAppState(state), true);
  assert.equal(store.isPreferencesValue(store.preferencesValue(state)), true);
  assert.equal(store.isClassValue(store.classValue('level-3', state.classes['level-3'])), true);
  assert.equal(store.isSavedDays(savedDays()), true);
  assert.equal(store.isSavedDayValue(savedDay()), true);

  const extra = workspace();
  extra.unexpected = true;
  assert.equal(store.isAppState(extra), false);

  const wrongGoal = workspace();
  wrongGoal.classes['level-3'].data.rows[0].goal = 20;
  assert.equal(store.isAppState(wrongGoal), false);

  const wrongValues = workspace();
  wrongValues.classes['level-3'].data.rows[0].values = [];
  assert.equal(store.isAppState(wrongValues), false);
});

await test('writes only an explicitly owned key and emits a local change', async () => {
  const { window, localStorage, store } = makeRuntime();
  const events = [];
  window.addEventListener(store.changeEvent, event => events.push(event.detail));
  await store.writeLocal(store.stateKey, workspace(), { source: 'local' });
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), workspace());
  assert.equal(events.length, 1);
  assert.equal(events[0].key, store.stateKey);
  assert.equal(events[0].source, 'local');
  assert.throws(
    () => store.writeLocal('unowned-key', workspace()),
    /unowned browser-storage key/
  );
});

await test('fails closed when an existing raw value is malformed', async () => {
  const { localStorage, store } = makeRuntime();
  const exactRaw = '{"private_marker":"DO_NOT_EXPOSE"';
  localStorage.setItem(store.stateKey, exactRaw);
  await assert.rejects(
    store.writeLocal(store.stateKey, workspace()),
    error => {
      assert.match(error.message, /not valid JSON/);
      assert.equal(error.message.includes('DO_NOT_EXPOSE'), false);
      return true;
    }
  );
  assert.equal(localStorage.getItem(store.stateKey), exactRaw);
  assert.equal(store.inspect()[store.stateKey].status, 'invalid');
});

await test('raw backup preserves exact owned values and excludes all other keys', () => {
  const { localStorage, store } = makeRuntime();
  const rawState = JSON.stringify(workspace());
  const rawDays = JSON.stringify(savedDays());
  localStorage.setItem(store.stateKey, rawState);
  localStorage.setItem(store.daysKey, rawDays);
  localStorage.setItem('unrelated-private-key', 'UNRELATED_PRIVATE_VALUE');
  localStorage.setItem('rings-floor-form-tracker-v1', 'LEGACY_PRIVATE_VALUE');
  const backup = store.rawBackup();
  const text = JSON.stringify(backup);

  assert.deepEqual(Array.from(backup.records, record => record.key), [
    'event-skill-tracker-v1',
    'event-skill-tracker-days-v1',
  ]);
  assert.equal(backup.records[0].raw_value, rawState);
  assert.equal(backup.records[1].raw_value, rawDays);
  assert.equal(text.includes('unrelated-private-key'), false);
  assert.equal(text.includes('UNRELATED_PRIVATE_VALUE'), false);
  assert.equal(text.includes('rings-floor-form-tracker-v1'), false);
  assert.equal(text.includes('LEGACY_PRIVATE_VALUE'), false);
});

await test('lists each saved day as an independently hashed record', async () => {
  const { localStorage, store } = makeRuntime();
  const archive = savedDays();
  archive.classes['level-3']['2026-07-29'] = savedDay('2026-07-29');
  archive.classes['level-3']['2026-07-29'].label = 'Jul 29, 2026 - Level 3';
  archive.classes['level-3']['2026-07-29'].savedAt = '2026-07-29T12:00:00.000Z';
  localStorage.setItem(store.daysKey, JSON.stringify(archive));
  const records = await store.listDayRecords();

  assert.equal(records.length, 2);
  assert.match(records[0].recordId, /^day:[a-f0-9]{64}$/);
  assert.notEqual(records[0].recordId, records[1].recordId);
  assert.equal(
    await store.verifyDayRecordId(records[0].recordId, records[0].value.classId, records[0].value.date),
    true
  );
});

await test('splits preferences and each class into independently staged records', async () => {
  const { localStorage, store } = makeRuntime();
  const state = workspace();
  localStorage.setItem(store.stateKey, JSON.stringify(state));
  const classes = await store.listClassRecords();
  assert.equal(classes.length, 1);
  assert.match(classes[0].recordId, /^class:[a-f0-9]{64}$/);
  assert.equal(classes[0].value.classId, 'level-3');
  assert.equal(store.isPreferencesValue(store.preferencesValue(state)), true);

  const changed = workspace();
  changed.classes['level-3'].data.rows[0].values[0] = '4';
  const diff = await store.diffStateRecords(JSON.stringify(state), JSON.stringify(changed));
  assert.equal(diff.preferencesChanged, false);
  assert.equal(diff.classes.length, 1);
  assert.equal(diff.classes[0].deleted, false);
  assert.equal(diff.classes[0].value.data.rows[0].values[0], '4');
});

await test('diffs added, changed, and deleted saved-day records without scanning storage', async () => {
  const { store } = makeRuntime();
  const before = savedDays();
  const after = savedDays('2026-07-29');
  const changes = await store.diffDayRecords(JSON.stringify(before), JSON.stringify(after));
  assert.equal(changes.length, 2);
  assert.deepEqual(Array.from(changes, change => change.deleted).sort(), [false, true]);
  assert.ok(changes.every(change => /^day:[a-f0-9]{64}$/.test(change.recordId)));
});

await test('rejects a mismatched remote saved-day identifier without changing local data', async () => {
  const { localStorage, store } = makeRuntime();
  const original = JSON.stringify(savedDays());
  localStorage.setItem(store.daysKey, original);
  await assert.rejects(
    store.applyDayRecord(`day:${'0'.repeat(64)}`, savedDay(), { source: 'remote' }),
    /saved-day record was rejected/
  );
  assert.equal(localStorage.getItem(store.daysKey), original);
});

await test('applies and deletes one valid remote saved-day record under the aggregate lock', async () => {
  const { localStorage, store } = makeRuntime();
  localStorage.setItem(store.daysKey, JSON.stringify(savedDays()));
  const [{ recordId, value }] = await store.listDayRecords();
  localStorage.setItem(store.daysKey, JSON.stringify({ classes: {} }));
  await store.applyDayRecord(recordId, value, { source: 'remote' });
  assert.deepEqual(
    JSON.parse(localStorage.getItem(store.daysKey)).classes['level-3']['2026-07-28'],
    value
  );
  await store.applyDayRecord(recordId, undefined, { source: 'remote', deleted: true });
  assert.deepEqual(JSON.parse(localStorage.getItem(store.daysKey)), { classes: {} });
});

await test('applies bounded remote preferences and class records without replacing other classes', async () => {
  const { localStorage, store } = makeRuntime();
  const state = workspace();
  state.classes.other = {
    ...JSON.parse(JSON.stringify(state.classes['level-3'])),
    name: 'Other',
  };
  localStorage.setItem(store.stateKey, JSON.stringify(state));

  const classValue = store.classValue('level-3', state.classes['level-3']);
  classValue.data.rows[0].values[0] = '14';
  const classRecordId = await store.classRecordId('level-3');
  await store.applyClassRecord(classRecordId, classValue, { source: 'remote' });
  let current = JSON.parse(localStorage.getItem(store.stateKey));
  assert.equal(current.classes['level-3'].data.rows[0].values[0], '14');
  assert.equal(current.classes.other.name, 'Other');

  const preferences = store.preferencesValue(current);
  preferences.settingsLocked = true;
  await store.applyPreferences(preferences, { source: 'remote' });
  current = JSON.parse(localStorage.getItem(store.stateKey));
  assert.equal(current.settingsLocked, true);
  assert.equal(current.classes.other.name, 'Other');

  await assert.rejects(
    store.applyClassRecord(classRecordId, undefined, {
      source: 'remote',
      deleted: true,
    }),
    /cannot delete the active/
  );
  assert.equal(JSON.parse(localStorage.getItem(store.stateKey)).classes['level-3'].name, 'Level 3');
});

await test('never permits synchronization to delete preferences', async () => {
  const { localStorage, store } = makeRuntime();
  const original = JSON.stringify(workspace());
  localStorage.setItem(store.stateKey, original);
  assert.throws(
    () => store.applyPreferences(undefined, { source: 'remote', deleted: true }),
    /cannot delete Skill Tracker preferences/
  );
  assert.equal(localStorage.getItem(store.stateKey), original);
});

await test('rejects stale local staging instead of replaying it over newer records', async () => {
  const { localStorage, store } = makeRuntime();
  const oldWorkspace = workspace();
  const newerWorkspace = workspace();
  newerWorkspace.classes['level-3'].data.rows[0].values[0] = '9';
  localStorage.setItem(store.stateKey, JSON.stringify(newerWorkspace));
  await assert.rejects(
    store.verifyCurrentPreferences({
      ...store.preferencesValue(oldWorkspace),
      settingsLocked: true,
    }),
    /Stale Skill Tracker preferences/
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), newerWorkspace);

  const oldClass = store.classValue('level-3', oldWorkspace.classes['level-3']);
  const classRecordId = await store.classRecordId('level-3');
  await assert.rejects(
    store.verifyCurrentClassRecord(classRecordId, oldClass),
    /stale class save/
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), newerWorkspace);

  const oldDays = savedDays();
  localStorage.setItem(store.daysKey, JSON.stringify(oldDays));
  const [{ recordId, value }] = await store.listDayRecords();
  const newerDays = savedDays();
  newerDays.classes['level-3']['2026-07-28'].rows[0].values[0] = '9';
  localStorage.setItem(store.daysKey, JSON.stringify(newerDays));
  await assert.rejects(
    store.verifyCurrentDayRecord(recordId, value),
    /stale saved-day save/
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(store.daysKey)), newerDays);
});

await test('fails closed when the shared aggregate lock is unavailable', async () => {
  const { window, localStorage, store } = makeRuntime();
  localStorage.setItem(store.daysKey, JSON.stringify(savedDays()));
  delete window.navigator.locks;
  assert.throws(
    () => store.listDayRecords(),
    /cannot safely coordinate/
  );
});

await test('keeps an oversized class local while explicitly blocking its registration', async () => {
  const { localStorage, store } = makeRuntime();
  const large = workspace();
  large.classes['level-3'].data.rows = Array.from({ length: 1800 }, (_, index) => ({
    event: 'floor',
    sheet: 'sheet-1',
    skill: `Long local skill ${index} ${'x'.repeat(70)}`,
    goal: '20',
    values: ['-'],
  }));
  assert.equal(store.isAppState(large), true);
  await store.writeLocal(store.stateKey, large, { source: 'local' });
  assert.ok(localStorage.getItem(store.stateKey).length > 128 * 1024);
  await assert.rejects(store.listClassRecords(), /class is larger than 128 KiB/);
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), large);
});

await test('keeps an oversized saved day local while explicitly blocking its registration', async () => {
  const { localStorage, store } = makeRuntime();
  const archive = savedDays();
  archive.classes['level-3']['2026-07-28'].rows = Array.from(
    { length: 1800 },
    (_, index) => ({
      event: 'floor',
      sheet: 'sheet-1',
      skill: `Long saved skill ${index} ${'x'.repeat(70)}`,
      goal: '20',
      values: ['-'],
    })
  );
  assert.equal(store.isSavedDays(archive), true);
  assert.equal(
    store.isSavedDayValue(archive.classes['level-3']['2026-07-28']),
    false
  );
  await store.writeLocal(store.daysKey, archive, { source: 'local' });
  assert.ok(localStorage.getItem(store.daysKey).length > 128 * 1024);
  await assert.rejects(store.listDayRecords(), /saved Skill Tracker day is too large/);
  assert.deepEqual(JSON.parse(localStorage.getItem(store.daysKey)), archive);
});

await test('uses the shared lock plus compare-and-swap for aggregate saves', async () => {
  const { localStorage, store } = makeRuntime();
  const original = workspace();
  await store.writeLocal(store.stateKey, original, { source: 'local' });
  const concurrent = workspace();
  concurrent.classes['level-3'].data.rows[0].values[0] = '12';
  localStorage.setItem(store.stateKey, JSON.stringify(concurrent));
  const staleReplacement = workspace();
  staleReplacement.classes['level-3'].data.rows[0].values[0] = '3';
  await assert.rejects(
    store.writeLocal(store.stateKey, staleReplacement, { source: 'local' }),
    /stopped a concurrent local save/
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), concurrent);

  const originalDays = savedDays();
  await store.writeLocal(store.daysKey, originalDays, { source: 'local' });
  const concurrentDays = savedDays();
  concurrentDays.classes['level-3']['2026-07-28'].rows[0].values[0] = '12';
  localStorage.setItem(store.daysKey, JSON.stringify(concurrentDays));
  await assert.rejects(
    store.writeLocal(store.daysKey, originalDays, { source: 'local' }),
    /stopped a concurrent local save/
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(store.daysKey)), concurrentDays);
});

await test('serializes rapid local aggregate writes so the newest mutation wins', async () => {
  const { localStorage, store, lockCalls } = makeRuntime();
  const first = workspace();
  first.classes['level-3'].data.rows[0].values[0] = '1';
  const second = workspace();
  second.classes['level-3'].data.rows[0].values[0] = '2';
  const third = workspace();
  third.classes['level-3'].data.rows[0].values[0] = '3';

  const writes = [
    store.writeLocal(store.stateKey, first, { source: 'local' }),
    store.writeLocal(store.stateKey, second, { source: 'local' }),
    store.writeLocal(store.stateKey, third, { source: 'local' }),
  ];
  await Promise.all(writes);

  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), third);
  assert.equal(lockCalls.length, 3);
  assert.ok(lockCalls.every(call => (
    call.name === store.lockName && call.options.mode === 'exclusive'
  )));
});

await test('merges serialized saved-day upserts under the same aggregate lock', async () => {
  const { localStorage, store, lockCalls } = makeRuntime();
  const first = savedDay('2026-07-28');
  const second = savedDay('2026-07-29');
  second.label = 'Jul 29, 2026 - Level 3';
  second.savedAt = '2026-07-29T12:00:00.000Z';

  await Promise.all([
    store.upsertSavedDay(first),
    store.upsertSavedDay(second),
  ]);

  const archive = JSON.parse(localStorage.getItem(store.daysKey));
  assert.deepEqual(Object.keys(archive.classes['level-3']).sort(), [
    '2026-07-28',
    '2026-07-29',
  ]);
  assert.equal(lockCalls.length, 2);
});

await test('remote revision fences preserve a newer local mutation', async () => {
  const { localStorage, store } = makeRuntime();
  const original = workspace();
  await store.writeLocal(store.stateKey, original, { source: 'local' });
  const requestedRevision = store.getRevision(store.stateKey);

  const newer = workspace();
  newer.classes['level-3'].data.rows[0].values[0] = '9';
  await store.writeLocal(store.stateKey, newer, { source: 'local' });

  const remote = store.classValue('level-3', original.classes['level-3']);
  remote.data.rows[0].values[0] = '4';
  await assert.rejects(
    store.applyClassRecord(await store.classRecordId('level-3'), remote, {
      source: 'remote',
      expectedLocalRevision: requestedRevision.local,
      expectedStorageRevision: requestedRevision.storage,
    }),
    /newer local Skill Tracker edit/
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), newer);
});

await test('remote async hashing uses raw compare-and-swap before commit', async () => {
  const { window, localStorage, store } = makeRuntime();
  const original = workspace();
  await store.writeLocal(store.stateKey, original, { source: 'local' });
  const recordId = await store.classRecordId('level-3');
  const remote = store.classValue('level-3', original.classes['level-3']);
  remote.data.rows[0].values[0] = '4';

  let releaseDigest;
  let hashingStarted;
  const started = new Promise(resolve => {
    hashingStarted = resolve;
  });
  window.crypto = {
    subtle: {
      digest: (...args) => {
        hashingStarted();
        return new Promise(resolve => {
          releaseDigest = async () => resolve(await webcrypto.subtle.digest(...args));
        });
      },
    },
  };

  const applying = store.applyClassRecord(recordId, remote, { source: 'remote' });
  await started;
  const newer = workspace();
  newer.classes['level-3'].data.rows[0].values[0] = '11';
  localStorage.setItem(store.stateKey, JSON.stringify(newer));
  await releaseDigest();

  await assert.rejects(applying, /newer Skill Tracker workspace was preserved/);
  assert.deepEqual(JSON.parse(localStorage.getItem(store.stateKey)), newer);
});

await test('detects and explicitly normalizes only proven historical shapes', async () => {
  const { localStorage, store } = makeRuntime();
  const oldState = workspace();
  delete oldState.classes['level-3'].hiddenAthletes;
  delete oldState.classes['level-3'].hiddenSkillKeys;
  const oldDays = savedDays();
  delete oldDays.classes['level-3']['2026-07-28'].hiddenAthletes;
  delete oldDays.classes['level-3']['2026-07-28'].hiddenSkillKeys;
  const oldStateRaw = JSON.stringify(oldState);
  const oldDaysRaw = JSON.stringify(oldDays);
  localStorage.setItem(store.stateKey, oldStateRaw);
  localStorage.setItem(store.daysKey, oldDaysRaw);

  const inspected = store.inspect();
  assert.equal(inspected[store.stateKey].status, 'recoverable');
  assert.equal(inspected[store.stateKey].format, 'workspace-2026-07-14');
  assert.equal(inspected[store.daysKey].status, 'recoverable');
  assert.match(inspected[store.daysKey].format, /2026-07-14-through-2026-07-23/);
  assert.equal(store.rawBackup().records[0].raw_value, oldStateRaw);
  assert.equal(store.rawBackup().records[1].raw_value, oldDaysRaw);
  assert.throws(
    () => store.normalizeRecoverable(),
    /Download the exact raw backup/
  );

  const normalized = await store.normalizeRecoverable({ backupConfirmed: true });
  assert.equal(normalized.length, 2);
  assert.equal(store.inspect()[store.stateKey].status, 'valid');
  assert.equal(store.inspect()[store.daysKey].status, 'valid');
  assert.deepEqual(
    JSON.parse(localStorage.getItem(store.stateKey)).classes['level-3'].hiddenAthletes,
    []
  );
  assert.deepEqual(
    JSON.parse(localStorage.getItem(store.daysKey))
      .classes['level-3']['2026-07-28'].hiddenSkillKeys,
    []
  );
});

await test('unknown current-key shapes fail closed and remain byte-for-byte unchanged', async () => {
  const { localStorage, store } = makeRuntime();
  const unknown = workspace();
  unknown.classes['level-3'].mysteryField = 'do-not-normalize';
  const exactRaw = JSON.stringify(unknown);
  localStorage.setItem(store.stateKey, exactRaw);

  const inspected = store.inspect()[store.stateKey];
  assert.equal(inspected.status, 'invalid');
  assert.match(inspected.error.message, /not a known Skill Tracker format/);
  await assert.rejects(
    store.normalizeRecoverable({ backupConfirmed: true }),
    /not a known Skill Tracker format/
  );
  assert.equal(localStorage.getItem(store.stateKey), exactRaw);
});

process.stdout.write(`1..${passed}\n`);
