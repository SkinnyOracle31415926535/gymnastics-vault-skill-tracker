(() => {
  'use strict';

  const APP_ID = 'skill-tracker';
  const STATE_KEY = 'event-skill-tracker-v1';
  const DAYS_KEY = 'event-skill-tracker-days-v1';
  const OWNED_KEYS = Object.freeze([STATE_KEY, DAYS_KEY]);
  const CHANGE_EVENT = 'skill-tracker-storage-change';
  const ERROR_EVENT = 'skill-tracker-storage-error';
  const LOCK_NAME = 'skill-tracker:aggregate-state-v1';
  const MAX_REMOTE_BYTES = 128 * 1024;
  const MAX_LOCAL_BYTES = 8 * 1024 * 1024;
  const MAX_CLASSES = 200;
  const MAX_ATHLETES = 500;
  const MAX_ROWS = 5000;
  const MAX_SAVED_DAYS = 5000;
  const EVENTS = new Set(['floor', 'mushroom', 'rings', 'vault', 'pbars', 'highbar']);
  const root = window;
  const objectConstructorSource = Function.prototype.toString.call(Object);
  const knownRaw = new Map();
  const revisions = new Map();
  const localWriteTails = new Map();
  let lastError = null;

  for (const key of OWNED_KEYS) {
    try {
      knownRaw.set(key, root.localStorage.getItem(key));
    } catch (error) {
      knownRaw.set(key, undefined);
      lastError = error instanceof Error ? error : new Error('Browser storage is unavailable.');
    }
    revisions.set(key, {
      mutation: 0,
      local: 0,
      external: 0,
      storage: 0,
    });
  }

  const clone = value => JSON.parse(JSON.stringify(value));
  const rawByteLength = raw => new TextEncoder().encode(raw).byteLength;
  const byteLength = value => rawByteLength(JSON.stringify(value));

  const plainObject = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = Object.prototype.hasOwnProperty.call(prototype, 'constructor')
      ? prototype.constructor
      : null;
    return typeof constructor === 'function'
      && Function.prototype.toString.call(constructor) === objectConstructorSource;
  };

  const exactKeys = (value, keys) => {
    if (!plainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = keys.slice().sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index]);
  };

  const validString = (value, maximum, allowEmpty = true) => (
    typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0)
  );

  const validStringArray = (value, maximumItems, maximumLength) => (
    Array.isArray(value)
    && value.length <= maximumItems
    && value.every(item => validString(item, maximumLength))
  );

  const validUniqueStringArray = (value, maximumItems, maximumLength) => (
    validStringArray(value, maximumItems, maximumLength)
    && new Set(value).size === value.length
  );

  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  };

  const validTimestamp = value => (
    validString(value, 64, false) && Number.isFinite(Date.parse(value))
  );

  const validClassId = value => (
    typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,159}$/.test(value)
  );

  const validSheetId = value => (
    typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,159}$/.test(value)
  );

  const validSheetKey = value => {
    if (typeof value !== 'string') return false;
    const parts = value.split('::');
    return parts.length === 2 && EVENTS.has(parts[0]) && validSheetId(parts[1]);
  };

  const validLabels = value => (
    plainObject(value)
    && Object.keys(value).length <= 1000
    && Object.entries(value).every(([key, label]) => (
      validSheetKey(key) && validString(label, 500, false)
    ))
  );

  const validRow = (value, athleteCount) => (
    exactKeys(value, ['event', 'sheet', 'skill', 'goal', 'values'])
    && EVENTS.has(value.event)
    && validSheetId(value.sheet)
    && validString(value.skill, 2000, false)
    && validString(value.goal, 100)
    && Array.isArray(value.values)
    && value.values.length === athleteCount
    && value.values.every(item => validString(item, 100))
  );

  const validClassData = (value, athleteCount) => (
    exactKeys(value, ['date', 'rows'])
    && validDate(value.date)
    && Array.isArray(value.rows)
    && value.rows.length <= MAX_ROWS
    && value.rows.every(row => validRow(row, athleteCount))
  );

  const classKeysForVersion = version => {
    const keys = [
      'name',
      'athletes',
      'removedRows',
      'removedSheets',
      'customSheets',
      'sheetLabels',
      'data',
    ];
    if (version >= 1) keys.push('hiddenAthletes');
    if (version >= 2) keys.push('hiddenSkillKeys');
    return keys;
  };

  const validClassRecordVersion = (value, version) => (
    exactKeys(value, classKeysForVersion(version))
    && validString(value.name, 500, false)
    && validUniqueStringArray(value.athletes, MAX_ATHLETES, 500)
    && (version < 1 || (
      validUniqueStringArray(value.hiddenAthletes, MAX_ATHLETES, 500)
      && value.hiddenAthletes.every(name => value.athletes.includes(name))
    ))
    && (version < 2 || validUniqueStringArray(value.hiddenSkillKeys, MAX_ROWS, 3000))
    && validUniqueStringArray(value.removedRows, MAX_ROWS, 3000)
    && validUniqueStringArray(value.removedSheets, 1000, 500)
    && validUniqueStringArray(value.customSheets, 1000, 500)
    && value.customSheets.every(validSheetKey)
    && validLabels(value.sheetLabels)
    && validClassData(value.data, value.athletes.length)
  );

  const validClassRecord = value => validClassRecordVersion(value, 2);

  const validStateEnvelope = (value, classValidator) => (
    exactKeys(value, [
      'activeClassId',
      'settingsLocked',
      'focusViewMode',
      'removedBuiltInClasses',
      'classes',
    ])
    && validClassId(value.activeClassId)
    && typeof value.settingsLocked === 'boolean'
    && value.focusViewMode === 'custom'
    && validUniqueStringArray(value.removedBuiltInClasses, MAX_CLASSES, 500)
    && plainObject(value.classes)
    && Object.keys(value.classes).length >= 1
    && Object.keys(value.classes).length <= MAX_CLASSES
    && Object.keys(value.classes).every(validClassId)
    && Object.values(value.classes).every(classValidator)
    && Object.prototype.hasOwnProperty.call(value.classes, value.activeClassId)
    && byteLength(value) <= MAX_LOCAL_BYTES
  );

  const isAppState = value => validStateEnvelope(value, validClassRecord);

  const historicalStateVersion = value => {
    if (validStateEnvelope(value, record => validClassRecordVersion(record, 0))) return 0;
    if (validStateEnvelope(value, record => validClassRecordVersion(record, 1))) return 1;
    return null;
  };

  const normalizeHistoricalState = (value, version) => {
    const normalized = clone(value);
    for (const record of Object.values(normalized.classes)) {
      if (version < 1) record.hiddenAthletes = [];
      if (version < 2) record.hiddenSkillKeys = [];
    }
    return normalized;
  };

  const isPreferencesValue = value => (
    exactKeys(value, [
      'activeClassId',
      'settingsLocked',
      'focusViewMode',
      'removedBuiltInClasses',
    ])
    && validClassId(value.activeClassId)
    && typeof value.settingsLocked === 'boolean'
    && value.focusViewMode === 'custom'
    && validUniqueStringArray(value.removedBuiltInClasses, MAX_CLASSES, 500)
    && byteLength(value) <= MAX_REMOTE_BYTES
  );

  const isClassValue = value => (
    exactKeys(value, [
      'classId',
      'name',
      'athletes',
      'hiddenAthletes',
      'hiddenSkillKeys',
      'removedRows',
      'removedSheets',
      'customSheets',
      'sheetLabels',
      'data',
    ])
    && validClassId(value.classId)
    && validClassRecord({
      name: value.name,
      athletes: value.athletes,
      hiddenAthletes: value.hiddenAthletes,
      hiddenSkillKeys: value.hiddenSkillKeys,
      removedRows: value.removedRows,
      removedSheets: value.removedSheets,
      customSheets: value.customSheets,
      sheetLabels: value.sheetLabels,
      data: value.data,
    })
    && byteLength(value) <= MAX_REMOTE_BYTES
  );

  const savedDayKeysForVersion = version => {
    const keys = [
      'classId',
      'className',
      'date',
      'label',
      'savedAt',
      'athletes',
      'customSheets',
      'sheetLabels',
      'rows',
    ];
    if (version >= 1) keys.push('hiddenAthletes', 'hiddenSkillKeys');
    return keys;
  };

  const validSavedDayVersion = (value, version) => (
    exactKeys(value, savedDayKeysForVersion(version))
    && validClassId(value.classId)
    && validString(value.className, 500, false)
    && validDate(value.date)
    && validString(value.label, 1000, false)
    && validTimestamp(value.savedAt)
    && validUniqueStringArray(value.athletes, MAX_ATHLETES, 500)
    && (version < 1 || (
      validUniqueStringArray(value.hiddenAthletes, MAX_ATHLETES, 500)
      && value.hiddenAthletes.every(name => value.athletes.includes(name))
      && validUniqueStringArray(value.hiddenSkillKeys, MAX_ROWS, 3000)
    ))
    && validUniqueStringArray(value.customSheets, 1000, 500)
    && value.customSheets.every(validSheetKey)
    && validLabels(value.sheetLabels)
    && Array.isArray(value.rows)
    && value.rows.length <= MAX_ROWS
    && value.rows.every(row => validRow(row, value.athletes.length))
  );

  const validSavedDayStructure = value => validSavedDayVersion(value, 1);
  const validSavedDayValue = value => (
    validSavedDayStructure(value) && byteLength(value) <= MAX_REMOTE_BYTES
  );

  const validSavedDaysVersion = (value, version) => {
    if (!exactKeys(value, ['classes']) || !plainObject(value.classes)) return false;
    const classIds = Object.keys(value.classes);
    if (classIds.length > MAX_CLASSES || !classIds.every(validClassId)) return false;
    let count = 0;
    for (const classId of classIds) {
      const days = value.classes[classId];
      if (!plainObject(days)) return false;
      for (const [date, record] of Object.entries(days)) {
        count += 1;
        if (count > MAX_SAVED_DAYS
          || !validDate(date)
          || !validSavedDayVersion(record, version)
          || record.classId !== classId
          || record.date !== date) {
          return false;
        }
      }
    }
    return byteLength(value) <= MAX_LOCAL_BYTES;
  };

  const isSavedDays = value => validSavedDaysVersion(value, 1);
  const isHistoricalSavedDays = value => validSavedDaysVersion(value, 0);

  const normalizeHistoricalSavedDays = value => {
    const normalized = clone(value);
    for (const records of Object.values(normalized.classes)) {
      for (const record of Object.values(records)) {
        record.hiddenAthletes = [];
        record.hiddenSkillKeys = [];
      }
    }
    return normalized;
  };

  const validationMessage = key => (
    key === STATE_KEY
      ? 'The saved Skill Tracker workspace has an invalid format.'
      : 'The saved Skill Tracker day archive has an invalid format.'
  );

  const inspectRaw = (key, raw) => {
    if (raw === null) {
      return {
        status: 'missing',
        raw,
        value: null,
        format: null,
        error: null,
      };
    }
    if (rawByteLength(raw) > MAX_LOCAL_BYTES) {
      return {
        status: 'invalid',
        raw,
        value: null,
        format: null,
        error: new Error(`${validationMessage(key)} It is larger than the safe local limit.`),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        status: 'invalid',
        raw,
        value: null,
        format: null,
        error: new Error(
          `${validationMessage(key)} It is not valid JSON. Download its exact raw backup.`
        ),
      };
    }
    if (key === STATE_KEY && isAppState(parsed)) {
      return {
        status: 'valid',
        raw,
        value: clone(parsed),
        format: 'workspace-current',
        error: null,
      };
    }
    if (key === DAYS_KEY && isSavedDays(parsed)) {
      return {
        status: 'valid',
        raw,
        value: clone(parsed),
        format: 'saved-days-current',
        error: null,
      };
    }
    if (key === STATE_KEY) {
      const version = historicalStateVersion(parsed);
      if (version !== null) {
        return {
          status: 'recoverable',
          raw,
          value: normalizeHistoricalState(parsed, version),
          format: version === 0
            ? 'workspace-2026-07-14'
            : 'workspace-2026-07-23',
          error: null,
        };
      }
    }
    if (key === DAYS_KEY && isHistoricalSavedDays(parsed)) {
      return {
        status: 'recoverable',
        raw,
        value: normalizeHistoricalSavedDays(parsed),
        format: 'saved-days-2026-07-14-through-2026-07-23',
        error: null,
      };
    }
    return {
      status: 'invalid',
      raw,
      value: null,
      format: null,
      error: new Error(
        `${validationMessage(key)} Its shape is not a known Skill Tracker format. `
        + 'Download its exact raw backup; it will not be normalized or overwritten.'
      ),
    };
  };

  const parseRaw = (key, raw) => {
    const inspected = inspectRaw(key, raw);
    if (inspected.status === 'valid' || inspected.status === 'missing') {
      return inspected.value;
    }
    if (inspected.status === 'recoverable') {
      throw new Error(
        `Skill Tracker recognized ${inspected.format} data. Download its exact raw backup, `
        + 'then use the explicit historical-data recovery action before saving or syncing.'
      );
    }
    throw inspected.error;
  };

  const assertOwnedKey = key => {
    if (!OWNED_KEYS.includes(key)) {
      throw new Error('Skill Tracker rejected an unowned browser-storage key.');
    }
  };

  const assertValue = (key, value) => {
    const valid = key === STATE_KEY
      ? isAppState(value)
      : key === DAYS_KEY && isSavedDays(value);
    if (!valid) {
      throw new Error(
        `${validationMessage(key)} Download its exact raw backup before making changes.`
      );
    }
    return value;
  };

  const publishError = error => {
    lastError = error instanceof Error ? error : new Error('Browser storage is unavailable.');
    root.dispatchEvent(new CustomEvent(ERROR_EVENT, {
      detail: { message: lastError.message },
    }));
  };

  const dispatchChange = detail => {
    root.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail }));
  };

  const withAggregateLock = callback => {
    if (!root.navigator?.locks?.request) {
      throw new Error(
        'This browser cannot safely coordinate Skill Tracker aggregate synchronization.'
      );
    }
    return root.navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, callback);
  };

  const currentRevision = key => ({ ...revisions.get(key) });

  const checkFence = (key, fence = {}) => {
    const current = revisions.get(key);
    if (Number.isInteger(fence.expectedMutationRevision)
      && current.mutation !== fence.expectedMutationRevision) {
      throw new Error(
        'Skill Tracker stopped a stale aggregate mutation before it could replace newer data.'
      );
    }
    if (Number.isInteger(fence.expectedLocalRevision)
      && current.local !== fence.expectedLocalRevision) {
      throw new Error(
        'A newer local Skill Tracker edit was preserved instead of synchronized data.'
      );
    }
    if (Number.isInteger(fence.expectedStorageRevision)
      && current.storage !== fence.expectedStorageRevision) {
      throw new Error(
        'A newer browser-tab Skill Tracker edit was preserved instead of synchronized data.'
      );
    }
    if (Number.isInteger(fence.expectedExternalRevision)
      && current.external !== fence.expectedExternalRevision) {
      throw new Error(
        'Skill Tracker stopped a local save because synchronized data changed first.'
      );
    }
  };

  const recordMutation = (key, source) => {
    const current = revisions.get(key);
    current.mutation += 1;
    if (source === 'local' || source === 'recovery') current.local += 1;
    if (source === 'remote' || source === 'migration' || source === 'storage') {
      current.external += 1;
    }
    if (source === 'storage') current.storage += 1;
  };

  const commitUnlocked = (key, candidate, {
    source,
    expectedRaw,
    ...fence
  }) => {
    assertOwnedKey(key);
    checkFence(key, fence);
    const next = clone(assertValue(key, candidate));
    const currentRaw = root.localStorage.getItem(key);
    if (expectedRaw !== undefined && currentRaw !== expectedRaw) {
      throw new Error(
        'Skill Tracker stopped a concurrent aggregate mutation before it could replace newer data.'
      );
    }
    if (currentRaw !== null) parseRaw(key, currentRaw);
    const nextRaw = JSON.stringify(next);
    if (currentRaw === nextRaw) {
      knownRaw.set(key, currentRaw);
      return next;
    }
    root.localStorage.setItem(key, nextRaw);
    if (root.localStorage.getItem(key) !== nextRaw) {
      throw new Error('Skill Tracker could not verify its local save.');
    }
    knownRaw.set(key, nextRaw);
    recordMutation(key, source);
    lastError = null;
    dispatchChange({
      key,
      source,
      oldRaw: currentRaw,
      newRaw: nextRaw,
      revision: currentRevision(key),
    });
    return next;
  };

  const enqueueLocalWrite = (key, operation) => {
    const previous = localWriteTails.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    localWriteTails.set(key, task);
    void task.finally(() => {
      if (localWriteTails.get(key) === task) localWriteTails.delete(key);
    }).catch(() => {});
    return task;
  };

  const writeLocal = (key, candidate, { source = 'local' } = {}) => {
    assertOwnedKey(key);
    if (source !== 'local') {
      throw new Error('Skill Tracker rejected a non-local aggregate save.');
    }
    const next = clone(assertValue(key, candidate));
    const expectedExternalRevision = revisions.get(key).external;
    return enqueueLocalWrite(key, () => withAggregateLock(() => {
      checkFence(key, { expectedExternalRevision });
      const currentRaw = root.localStorage.getItem(key);
      if (currentRaw !== null) parseRaw(key, currentRaw);
      if (knownRaw.get(key) !== currentRaw) {
        throw new Error(
          'Skill Tracker stopped a concurrent local save before it could replace newer data.'
        );
      }
      return commitUnlocked(key, next, {
        source: 'local',
        expectedRaw: currentRaw,
        expectedExternalRevision,
      });
    })).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const upsertSavedDay = snapshot => {
    const nextSnapshot = clone(snapshot);
    if (!validSavedDayValue(nextSnapshot)) {
      throw new Error('The Skill Tracker saved-day snapshot has an invalid format.');
    }
    const expectedExternalRevision = revisions.get(DAYS_KEY).external;
    return enqueueLocalWrite(DAYS_KEY, () => withAggregateLock(() => {
      checkFence(DAYS_KEY, { expectedExternalRevision });
      const currentRaw = root.localStorage.getItem(DAYS_KEY);
      if (currentRaw !== null) parseRaw(DAYS_KEY, currentRaw);
      if (knownRaw.get(DAYS_KEY) !== currentRaw) {
        throw new Error(
          'Skill Tracker stopped a concurrent saved-day update before it could replace newer data.'
        );
      }
      const days = parseRaw(DAYS_KEY, currentRaw) || { classes: {} };
      if (!days.classes[nextSnapshot.classId]) days.classes[nextSnapshot.classId] = {};
      days.classes[nextSnapshot.classId][nextSnapshot.date] = nextSnapshot;
      return commitUnlocked(DAYS_KEY, days, {
        source: 'local',
        expectedRaw: currentRaw,
        expectedExternalRevision,
      });
    })).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const removeSavedDaysForClass = classId => {
    if (!validClassId(classId)) {
      throw new Error('Skill Tracker could not identify the class archive to remove.');
    }
    const expectedExternalRevision = revisions.get(DAYS_KEY).external;
    return enqueueLocalWrite(DAYS_KEY, () => withAggregateLock(() => {
      checkFence(DAYS_KEY, { expectedExternalRevision });
      const currentRaw = root.localStorage.getItem(DAYS_KEY);
      if (currentRaw !== null) parseRaw(DAYS_KEY, currentRaw);
      if (knownRaw.get(DAYS_KEY) !== currentRaw) {
        throw new Error(
          'Skill Tracker stopped a concurrent class-archive update before it could replace newer data.'
        );
      }
      const days = parseRaw(DAYS_KEY, currentRaw) || { classes: {} };
      if (!Object.prototype.hasOwnProperty.call(days.classes, classId)) return days;
      delete days.classes[classId];
      return commitUnlocked(DAYS_KEY, days, {
        source: 'local',
        expectedRaw: currentRaw,
        expectedExternalRevision,
      });
    })).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const replaceAllLocal = (state, days) => {
    const nextState = clone(assertValue(STATE_KEY, state));
    const nextDays = clone(assertValue(DAYS_KEY, days));
    const expectedStateExternal = revisions.get(STATE_KEY).external;
    const expectedDaysExternal = revisions.get(DAYS_KEY).external;
    const stateTail = localWriteTails.get(STATE_KEY) || Promise.resolve();
    const daysTail = localWriteTails.get(DAYS_KEY) || Promise.resolve();
    const task = Promise.allSettled([stateTail, daysTail]).then(() => (
      withAggregateLock(() => {
        checkFence(STATE_KEY, { expectedExternalRevision: expectedStateExternal });
        checkFence(DAYS_KEY, { expectedExternalRevision: expectedDaysExternal });
        const stateRaw = root.localStorage.getItem(STATE_KEY);
        const daysRaw = root.localStorage.getItem(DAYS_KEY);
        if (stateRaw !== null) parseRaw(STATE_KEY, stateRaw);
        if (daysRaw !== null) parseRaw(DAYS_KEY, daysRaw);
        if (knownRaw.get(STATE_KEY) !== stateRaw || knownRaw.get(DAYS_KEY) !== daysRaw) {
          throw new Error(
            'Skill Tracker stopped a concurrent restore before it could replace newer data.'
          );
        }
        commitUnlocked(STATE_KEY, nextState, {
          source: 'local',
          expectedRaw: stateRaw,
          expectedExternalRevision: expectedStateExternal,
        });
        return commitUnlocked(DAYS_KEY, nextDays, {
          source: 'local',
          expectedRaw: daysRaw,
          expectedExternalRevision: expectedDaysExternal,
        });
      })
    ));
    localWriteTails.set(STATE_KEY, task);
    localWriteTails.set(DAYS_KEY, task);
    void task.finally(() => {
      if (localWriteTails.get(STATE_KEY) === task) localWriteTails.delete(STATE_KEY);
      if (localWriteTails.get(DAYS_KEY) === task) localWriteTails.delete(DAYS_KEY);
    }).catch(() => {});
    return task.catch(error => {
      publishError(error);
      throw error;
    });
  };

  const normalizeRecoverable = ({ backupConfirmed = false } = {}) => {
    if (!backupConfirmed) {
      throw new Error('Download the exact raw backup before normalizing historical data.');
    }
    return withAggregateLock(() => {
      const snapshots = new Map();
      for (const key of OWNED_KEYS) {
        const raw = root.localStorage.getItem(key);
        const inspected = inspectRaw(key, raw);
        if (inspected.status === 'invalid') throw inspected.error;
        snapshots.set(key, inspected);
      }
      const normalized = [];
      for (const key of OWNED_KEYS) {
        const inspected = snapshots.get(key);
        if (root.localStorage.getItem(key) !== inspected.raw) {
          throw new Error(
            'Historical Skill Tracker data changed during recovery. Nothing was normalized.'
          );
        }
        if (inspected.status !== 'recoverable') continue;
        const nextRaw = JSON.stringify(inspected.value);
        root.localStorage.setItem(key, nextRaw);
        if (root.localStorage.getItem(key) !== nextRaw) {
          throw new Error('Skill Tracker could not verify historical-data recovery.');
        }
        knownRaw.set(key, nextRaw);
        recordMutation(key, 'recovery');
        dispatchChange({
          key,
          source: 'recovery',
          oldRaw: inspected.raw,
          newRaw: nextRaw,
          revision: currentRevision(key),
        });
        normalized.push({ key, format: inspected.format });
      }
      lastError = null;
      return normalized;
    }).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const recordSource = (days, classId, date) => days?.classes?.[classId]?.[date];
  const dayIdentity = (classId, date) => `${classId}\u001f${date}`;

  const hashedRecordId = async (prefix, identity) => {
    const digest = await root.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(identity)
    );
    const hex = Array.from(
      new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, '0')
    ).join('');
    return `${prefix}:${hex}`;
  };

  const classRecordId = async classId => {
    if (!validClassId(classId)) {
      throw new Error('Skill Tracker could not identify a class record.');
    }
    return hashedRecordId('class', classId);
  };

  const verifyClassRecordId = async (recordId, classId) => (
    typeof recordId === 'string' && recordId === await classRecordId(classId)
  );

  const dayRecordId = async (classId, date) => {
    if (!validClassId(classId) || !validDate(date)) {
      throw new Error('Skill Tracker could not identify a saved-day record.');
    }
    return hashedRecordId('day', dayIdentity(classId, date));
  };

  const verifyDayRecordId = async (recordId, classId, date) => (
    typeof recordId === 'string' && recordId === await dayRecordId(classId, date)
  );

  const readState = () => parseRaw(STATE_KEY, root.localStorage.getItem(STATE_KEY));

  const preferencesValue = state => {
    if (!isAppState(state)) throw new Error('The Skill Tracker workspace is invalid.');
    return clone({
      activeClassId: state.activeClassId,
      settingsLocked: state.settingsLocked,
      focusViewMode: state.focusViewMode,
      removedBuiltInClasses: state.removedBuiltInClasses,
    });
  };

  const classValue = (classId, record) => {
    if (!validClassId(classId) || !validClassRecord(record)) {
      throw new Error('A Skill Tracker class has an invalid format.');
    }
    return clone({ classId, ...record });
  };

  const listClassRecordsUnlocked = async state => {
    if (state === null) return [];
    const items = [];
    for (const classId of Object.keys(state.classes).sort()) {
      const value = classValue(classId, state.classes[classId]);
      if (!isClassValue(value)) {
        throw new Error(
          'A Skill Tracker class is larger than 128 KiB. It remains local and synchronization is blocked.'
        );
      }
      items.push({ recordId: await classRecordId(classId), value });
    }
    return items;
  };

  const listClassRecords = () => (
    withAggregateLock(() => listClassRecordsUnlocked(readState()))
  );

  const classMap = state => {
    const result = new Map();
    if (!state) return result;
    for (const [classId, record] of Object.entries(state.classes)) {
      result.set(classId, classValue(classId, record));
    }
    return result;
  };

  const diffStateRecords = async (oldRaw, newRaw) => {
    const previous = parseRaw(STATE_KEY, oldRaw);
    const next = parseRaw(STATE_KEY, newRaw);
    if (next === null) {
      throw new Error('Skill Tracker synchronization cannot stage a deleted workspace.');
    }
    const beforePreferences = previous ? preferencesValue(previous) : undefined;
    const afterPreferences = preferencesValue(next);
    const beforeClasses = classMap(previous);
    const afterClasses = classMap(next);
    const classIds = [...new Set([...beforeClasses.keys(), ...afterClasses.keys()])].sort();
    const classes = [];
    for (const classId of classIds) {
      const oldValue = beforeClasses.get(classId);
      const newValue = afterClasses.get(classId);
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      if (newValue !== undefined && !isClassValue(newValue)) {
        throw new Error(
          'A changed Skill Tracker class is larger than 128 KiB. '
          + 'It remains local and was not synchronized.'
        );
      }
      classes.push({
        recordId: await classRecordId(classId),
        deleted: newValue === undefined,
        value: newValue === undefined ? undefined : clone(newValue),
      });
    }
    return {
      preferencesChanged:
        JSON.stringify(beforePreferences) !== JSON.stringify(afterPreferences),
      preferences: afterPreferences,
      classes,
    };
  };

  const readSavedDays = () => (
    parseRaw(DAYS_KEY, root.localStorage.getItem(DAYS_KEY)) || { classes: {} }
  );

  const listDayRecordsUnlocked = async days => {
    const items = [];
    for (const classId of Object.keys(days.classes).sort()) {
      for (const date of Object.keys(days.classes[classId]).sort()) {
        const value = clone(days.classes[classId][date]);
        if (!validSavedDayValue(value)) {
          throw new Error(
            'A saved Skill Tracker day is too large or invalid. '
            + 'It remains local and was not synchronized.'
          );
        }
        items.push({ recordId: await dayRecordId(classId, date), value });
      }
    }
    return items;
  };

  const listDayRecords = () => (
    withAggregateLock(() => listDayRecordsUnlocked(readSavedDays()))
  );

  const dayMap = days => {
    const result = new Map();
    for (const [classId, records] of Object.entries(days.classes)) {
      for (const [date, value] of Object.entries(records)) {
        result.set(dayIdentity(classId, date), value);
      }
    }
    return result;
  };

  const diffDayRecords = async (oldRaw, newRaw) => {
    const previous = parseRaw(DAYS_KEY, oldRaw) || { classes: {} };
    const next = parseRaw(DAYS_KEY, newRaw) || { classes: {} };
    const before = dayMap(previous);
    const after = dayMap(next);
    const identities = [...new Set([...before.keys(), ...after.keys()])].sort();
    const changes = [];
    for (const identity of identities) {
      const [classId, date] = identity.split('\u001f');
      const oldValue = before.get(identity);
      const newValue = after.get(identity);
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      if (newValue !== undefined && !validSavedDayValue(newValue)) {
        throw new Error(
          'A changed saved Skill Tracker day is larger than 128 KiB. '
          + 'It remains local and was not synchronized.'
        );
      }
      changes.push({
        recordId: await dayRecordId(classId, date),
        deleted: newValue === undefined,
        value: newValue === undefined ? undefined : clone(newValue),
      });
    }
    return changes;
  };

  const remoteFence = options => ({
    expectedLocalRevision: options.expectedLocalRevision,
    expectedStorageRevision: options.expectedStorageRevision,
  });

  const applyPreferences = (value, {
    source = 'sync',
    deleted = false,
    ...options
  } = {}) => {
    if (deleted) {
      throw new Error('Synchronization cannot delete Skill Tracker preferences.');
    }
    if (!isPreferencesValue(value)) {
      throw new Error('Synchronized Skill Tracker preferences were rejected.');
    }
    return withAggregateLock(() => {
      checkFence(STATE_KEY, remoteFence(options));
      const startingRaw = root.localStorage.getItem(STATE_KEY);
      const state = parseRaw(STATE_KEY, startingRaw);
      if (!state || !state.classes[value.activeClassId]) {
        throw new Error(
          'Synchronized Skill Tracker preferences do not match the local classes.'
        );
      }
      state.activeClassId = value.activeClassId;
      state.settingsLocked = value.settingsLocked;
      state.focusViewMode = value.focusViewMode;
      state.removedBuiltInClasses = clone(value.removedBuiltInClasses);
      return commitUnlocked(STATE_KEY, state, {
        source: source === 'migration' ? 'migration' : 'remote',
        expectedRaw: startingRaw,
        ...remoteFence(options),
      });
    }).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const findClassByRecordId = async (state, recordId) => {
    for (const classId of Object.keys(state.classes)) {
      if (await verifyClassRecordId(recordId, classId)) return classId;
    }
    return null;
  };

  const applyClassRecord = (recordId, value, {
    source = 'sync',
    deleted = false,
    ...options
  } = {}) => withAggregateLock(async () => {
    checkFence(STATE_KEY, remoteFence(options));
    if (typeof recordId !== 'string' || !/^class:[a-f0-9]{64}$/.test(recordId)) {
      throw new Error('A synchronized class identifier was rejected.');
    }
    const startingRaw = root.localStorage.getItem(STATE_KEY);
    const state = parseRaw(STATE_KEY, startingRaw);
    if (!state) {
      throw new Error('A synchronized class cannot replace a missing local workspace.');
    }
    if (deleted) {
      const classId = await findClassByRecordId(state, recordId);
      checkFence(STATE_KEY, remoteFence(options));
      if (root.localStorage.getItem(STATE_KEY) !== startingRaw) {
        throw new Error('A newer Skill Tracker workspace was preserved.');
      }
      if (!classId) return;
      if (classId === state.activeClassId || Object.keys(state.classes).length <= 1) {
        throw new Error(
          'Synchronization cannot delete the active or only Skill Tracker class.'
        );
      }
      delete state.classes[classId];
    } else {
      if (!isClassValue(value)
        || !await verifyClassRecordId(recordId, value.classId)) {
        throw new Error(
          'A synchronized Skill Tracker class was rejected. Local data was preserved.'
        );
      }
      checkFence(STATE_KEY, remoteFence(options));
      if (root.localStorage.getItem(STATE_KEY) !== startingRaw) {
        throw new Error('A newer Skill Tracker workspace was preserved.');
      }
      state.classes[value.classId] = clone({
        name: value.name,
        athletes: value.athletes,
        hiddenAthletes: value.hiddenAthletes,
        hiddenSkillKeys: value.hiddenSkillKeys,
        removedRows: value.removedRows,
        removedSheets: value.removedSheets,
        customSheets: value.customSheets,
        sheetLabels: value.sheetLabels,
        data: value.data,
      });
    }
    return commitUnlocked(STATE_KEY, state, {
      source: source === 'migration' ? 'migration' : 'remote',
      expectedRaw: startingRaw,
      ...remoteFence(options),
    });
  }).catch(error => {
    publishError(error);
    throw error;
  });

  const verifyCurrentPreferences = (value, { deleted = false } = {}) => (
    withAggregateLock(() => {
      const current = readState();
      if (deleted || current === null
        || JSON.stringify(preferencesValue(current)) !== JSON.stringify(value)) {
        throw new Error(
          'Stale Skill Tracker preferences were not allowed to replace newer local data.'
        );
      }
      return clone(value);
    })
  );

  const verifyCurrentClassRecord = (recordId, value, { deleted = false } = {}) => (
    withAggregateLock(async () => {
      if (typeof recordId !== 'string' || !/^class:[a-f0-9]{64}$/.test(recordId)) {
        throw new Error('A staged class identifier was rejected.');
      }
      const state = readState();
      if (!state) throw new Error('A staged class cannot use a missing local workspace.');
      const existingClassId = await findClassByRecordId(state, recordId);
      if (deleted) {
        if (existingClassId) {
          throw new Error(
            'A stale class deletion was not allowed to remove newer local data.'
          );
        }
        return;
      }
      if (!isClassValue(value)
        || !await verifyClassRecordId(recordId, value.classId)
        || existingClassId !== value.classId
        || JSON.stringify(classValue(value.classId, state.classes[value.classId]))
          !== JSON.stringify(value)) {
        throw new Error(
          'A stale class save was not allowed to replace newer local data.'
        );
      }
      return clone(value);
    })
  );

  const findDayByRecordId = async (days, recordId) => {
    for (const [classId, records] of Object.entries(days.classes)) {
      for (const date of Object.keys(records)) {
        if (await verifyDayRecordId(recordId, classId, date)) return { classId, date };
      }
    }
    return null;
  };

  const applyDayRecord = (recordId, value, {
    source = 'sync',
    deleted = false,
    ...options
  } = {}) => withAggregateLock(async () => {
    checkFence(DAYS_KEY, remoteFence(options));
    if (typeof recordId !== 'string' || !/^day:[a-f0-9]{64}$/.test(recordId)) {
      throw new Error('A synchronized saved-day identifier was rejected.');
    }
    const startingRaw = root.localStorage.getItem(DAYS_KEY);
    const days = parseRaw(DAYS_KEY, startingRaw) || { classes: {} };
    if (deleted) {
      const existing = await findDayByRecordId(days, recordId);
      checkFence(DAYS_KEY, remoteFence(options));
      if (root.localStorage.getItem(DAYS_KEY) !== startingRaw) {
        throw new Error('A newer Skill Tracker saved-day archive was preserved.');
      }
      if (!existing) return;
      delete days.classes[existing.classId][existing.date];
      if (!Object.keys(days.classes[existing.classId]).length) {
        delete days.classes[existing.classId];
      }
    } else {
      if (!validSavedDayValue(value)
        || !await verifyDayRecordId(recordId, value.classId, value.date)) {
        throw new Error(
          'A synchronized saved-day record was rejected. Local data was preserved.'
        );
      }
      checkFence(DAYS_KEY, remoteFence(options));
      if (root.localStorage.getItem(DAYS_KEY) !== startingRaw) {
        throw new Error('A newer Skill Tracker saved-day archive was preserved.');
      }
      if (!days.classes[value.classId]) days.classes[value.classId] = {};
      days.classes[value.classId][value.date] = clone(value);
    }
    return commitUnlocked(DAYS_KEY, days, {
      source: source === 'migration' ? 'migration' : 'remote',
      expectedRaw: startingRaw,
      ...remoteFence(options),
    });
  }).catch(error => {
    publishError(error);
    throw error;
  });

  const verifyCurrentDayRecord = (recordId, value, { deleted = false } = {}) => (
    withAggregateLock(async () => {
      if (typeof recordId !== 'string' || !/^day:[a-f0-9]{64}$/.test(recordId)) {
        throw new Error('A staged saved-day identifier was rejected.');
      }
      const days = readSavedDays();
      const existing = await findDayByRecordId(days, recordId);
      if (deleted) {
        if (existing) {
          throw new Error(
            'A stale saved-day deletion was not allowed to remove newer local data.'
          );
        }
        return;
      }
      if (!validSavedDayValue(value)
        || !await verifyDayRecordId(recordId, value.classId, value.date)
        || !existing
        || JSON.stringify(recordSource(days, existing.classId, existing.date))
          !== JSON.stringify(value)) {
        throw new Error(
          'A stale saved-day save was not allowed to replace newer local data.'
        );
      }
      return clone(value);
    })
  );

  const inspect = () => {
    const result = {};
    for (const key of OWNED_KEYS) {
      let raw = null;
      try {
        raw = root.localStorage.getItem(key);
        result[key] = inspectRaw(key, raw);
      } catch (error) {
        result[key] = {
          status: 'invalid',
          raw,
          value: null,
          format: null,
          error,
        };
      }
    }
    const invalid = Object.values(result).find(item => item.status === 'invalid');
    if (invalid) lastError = invalid.error;
    else lastError = null;
    return result;
  };

  const rawBackup = () => ({
    version: 1,
    kind: 'skill_tracker_browser_local_raw_backup',
    app_id: APP_ID,
    exported_at: new Date().toISOString(),
    records: OWNED_KEYS.map(key => {
      const raw = root.localStorage.getItem(key);
      return { key, present: raw !== null, raw_value: raw };
    }),
  });

  root.addEventListener('storage', event => {
    if (!OWNED_KEYS.includes(event.key)) return;
    try {
      if (event.newValue !== null) parseRaw(event.key, event.newValue);
      knownRaw.set(event.key, event.newValue);
      recordMutation(event.key, 'storage');
      lastError = null;
      dispatchChange({
        key: event.key,
        source: 'storage',
        oldRaw: event.oldValue,
        newRaw: event.newValue,
        revision: currentRevision(event.key),
      });
    } catch (error) {
      publishError(error);
    }
  });

  root.SkillTrackerStore = Object.freeze({
    appId: APP_ID,
    stateKey: STATE_KEY,
    daysKey: DAYS_KEY,
    changeEvent: CHANGE_EVENT,
    errorEvent: ERROR_EVENT,
    lockName: LOCK_NAME,
    maxRemoteBytes: MAX_REMOTE_BYTES,
    inspect,
    inspectRaw,
    rawBackup,
    normalizeRecoverable,
    writeLocal,
    upsertSavedDay,
    removeSavedDaysForClass,
    replaceAllLocal,
    readState,
    readSavedDays,
    preferencesValue,
    classValue,
    listClassRecords,
    diffStateRecords,
    listDayRecords,
    diffDayRecords,
    classRecordId,
    verifyClassRecordId,
    dayRecordId,
    verifyDayRecordId,
    applyPreferences,
    applyClassRecord,
    applyDayRecord,
    verifyCurrentPreferences,
    verifyCurrentClassRecord,
    verifyCurrentDayRecord,
    isAppState,
    isPreferencesValue,
    isClassValue,
    isSavedDays,
    isSavedDayValue: validSavedDayValue,
    getRevision: key => {
      assertOwnedKey(key);
      return currentRevision(key);
    },
    getLastError: () => lastError,
  });
})();
