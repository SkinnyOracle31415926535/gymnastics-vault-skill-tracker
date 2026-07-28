(() => {
  'use strict';

  const APP_ID = 'skill-tracker';
  const MANIFEST_VERSION = 1;
  const store = window.SkillTrackerStore;
  const backupButton = document.querySelector('#downloadBackupButton');

  if (!document.body || !backupButton) return;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'skill-sync-open';
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'Sync & backup';
  backupButton.insertAdjacentElement('afterend', openButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'skill-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'skill-sync-title');
  dialog.innerHTML = `
    <div class="skill-sync-window">
      <div class="skill-sync-heading">
        <div>
          <p class="skill-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="skill-sync-title">Sync & backup</h2>
        </div>
        <button type="button" class="skill-sync-close" data-skill-sync-close
          aria-label="Close sync and backup window">×</button>
      </div>
      <p class="skill-sync-copy">
        Tracker preferences, each class, and each saved day can sync separately between
        Ryan’s browsers. Changes still save in this browser first.
      </p>
      <p class="skill-sync-safety">
        Only <code>event-skill-tracker-v1</code> and
        <code>event-skill-tracker-days-v1</code> are read. Legacy imports and every
        unrelated browser key stay outside synchronization.
      </p>
      <div class="skill-sync-state" data-skill-sync-state data-state="disconnected">
        <strong data-skill-sync-state-label>Disconnected</strong>
        <span data-skill-sync-state-message>Local Skill Tracker data stays on this device.</span>
      </div>
      <p class="skill-sync-alert" data-skill-sync-alert role="alert" hidden></p>
      <div class="skill-sync-actions">
        <button type="button" class="is-primary" data-skill-sync-connect data-sync-action>
          Connect as Ryan
        </button>
        <button type="button" data-skill-sync-now data-sync-action>Sync now</button>
        <button type="button" data-skill-sync-backup data-sync-action>
          Download exact local backup
        </button>
        <button type="button" data-skill-sync-recover data-sync-action hidden>
          Back up & normalize historical data
        </button>
        <button type="button" data-skill-sync-preview data-sync-action>
          Create backup & preview
        </button>
        <button type="button" data-skill-sync-disconnect data-sync-action>Disconnect</button>
        <button type="button" data-skill-sync-reset data-sync-action>
          Reset device connection
        </button>
      </div>
      <section class="skill-sync-review" data-skill-sync-review hidden
        aria-labelledby="skill-sync-review-title">
        <h3 id="skill-sync-review-title">Migration preview</h3>
        <p data-skill-sync-counts></p>
        <p class="skill-sync-zero-write" data-skill-sync-zero-write></p>
        <div class="skill-sync-records" data-skill-sync-records></div>
        <button type="button" class="is-primary" data-skill-sync-apply data-sync-action disabled>
          Apply reviewed migration
        </button>
      </section>
      <section class="skill-sync-conflicts" data-skill-sync-conflicts hidden
        aria-labelledby="skill-sync-conflicts-title">
        <h3 id="skill-sync-conflicts-title">Sync conflicts</h3>
        <p>Choose each complete record deliberately. Nothing is selected automatically.</p>
        <div class="skill-sync-conflict-list" data-skill-sync-conflict-list></div>
      </section>
      <p class="skill-sync-footnote">
        Authentication stays only in this open page. Resetting the device connection
        preserves all local tracker data and requires a new zero-write preview.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-skill-sync-close]');
  const connectButton = dialog.querySelector('[data-skill-sync-connect]');
  const syncButton = dialog.querySelector('[data-skill-sync-now]');
  const localBackupButton = dialog.querySelector('[data-skill-sync-backup]');
  const recoveryButton = dialog.querySelector('[data-skill-sync-recover]');
  const previewButton = dialog.querySelector('[data-skill-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-skill-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-skill-sync-reset]');
  const applyButton = dialog.querySelector('[data-skill-sync-apply]');
  const stateBox = dialog.querySelector('[data-skill-sync-state]');
  const stateLabel = dialog.querySelector('[data-skill-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-skill-sync-state-message]');
  const alertBox = dialog.querySelector('[data-skill-sync-alert]');
  const review = dialog.querySelector('[data-skill-sync-review]');
  const counts = dialog.querySelector('[data-skill-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-skill-sync-zero-write]');
  const records = dialog.querySelector('[data-skill-sync-records]');
  const conflicts = dialog.querySelector('[data-skill-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-skill-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let preferencesHandle = null;
  let classesHandle = null;
  let daysHandle = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let conflictRender = 0;
  let restoreFocus = null;
  let ready = Promise.resolve();
  let stagingDrain = Promise.resolve();
  let stagingActive = false;
  let remoteApplyTail = Promise.resolve();
  const pendingStages = new Map();

  const stateLabels = Object.freeze({
    disconnected: 'Disconnected',
    review: 'Migration review required',
    syncing: 'Syncing',
    synced: 'Synced',
    offline: 'Offline',
    conflict: 'Conflict needs review',
  });

  const showAlert = (message = '') => {
    alertBox.hidden = !message;
    alertBox.textContent = message;
  };

  const setBusy = next => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach(button => {
      if (button === applyButton && !next) return;
      button.disabled = next;
    });
    if (!next) updateApplyAvailability();
  };

  const downloadJson = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    if (!store) throw new Error('The Skill Tracker local data store did not load.');
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(
      store.rawBackup(),
      `skill-tracker-browser-local-raw-backup-${today}.json`
    );
  };

  const requireWriteSource = metadata => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid Skill Tracker local-write source.');
    }
  };

  const requireRemoteSource = metadata => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid Skill Tracker remote-write source.');
    }
  };

  const whenStagingSettled = async () => {
    while (stagingActive || pendingStages.size) {
      const currentDrain = stagingDrain;
      await currentDrain.catch(() => {});
      if (currentDrain === stagingDrain && !stagingActive && !pendingStages.size) return;
    }
  };

  const waitForEditorIdle = async () => {
    const bridge = window.SkillTrackerAppBridge;
    if (!bridge?.hasActiveEditor?.()) return;
    if (typeof bridge.whenEditorIdle === 'function') {
      await bridge.whenEditorIdle();
      return;
    }
    await new Promise(resolve => {
      const check = () => {
        if (!bridge.hasActiveEditor()) resolve();
        else window.setTimeout(check, 25);
      };
      check();
    });
  };

  const queueRemoteApply = (key, metadata, operation) => {
    requireRemoteSource(metadata);
    const requestedRevision = store.getRevision(key);
    const task = remoteApplyTail.catch(() => {}).then(async () => {
      await whenStagingSettled();
      await waitForEditorIdle();
      await whenStagingSettled();
      const currentRevision = store.getRevision(key);
      if (currentRevision.local !== requestedRevision.local
        || currentRevision.storage !== requestedRevision.storage) {
        throw new Error(
          'A newer local Skill Tracker edit was preserved instead of deferred synchronized data.'
        );
      }
      return operation({
        expectedLocalRevision: requestedRevision.local,
        expectedStorageRevision: requestedRevision.storage,
      });
    });
    remoteApplyTail = task;
    return task;
  };

  const preferencesAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'preferences',
    recordId: 'current',
    schemaVersion: 1,
    validate: value => store.isPreferencesValue(value),
    readLocal: () => {
      const state = store.readState();
      return state === null ? undefined : store.preferencesValue(state);
    },
    writeLocal: (value, metadata) => {
      requireWriteSource(metadata);
      if (metadata.source === 'local') {
        return store.verifyCurrentPreferences(value, {
          deleted: Boolean(metadata.deleted),
        });
      }
      return queueRemoteApply(store.stateKey, { source: 'migration' }, fence => (
        store.applyPreferences(value, {
          source: 'migration',
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
    applyRemote: (value, metadata) => {
      return queueRemoteApply(store.stateKey, metadata, fence => (
        store.applyPreferences(value, {
          source: metadata.source,
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
  };

  const classesAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'classes',
    schemaVersion: 1,
    validate: value => store.isClassValue(value),
    listLocal: () => store.listClassRecords(),
    writeLocal: (recordId, value, metadata) => {
      requireWriteSource(metadata);
      if (metadata.source === 'local') {
        return store.verifyCurrentClassRecord(recordId, value, {
          deleted: Boolean(metadata.deleted),
        });
      }
      return queueRemoteApply(store.stateKey, { source: 'migration' }, fence => (
        store.applyClassRecord(recordId, value, {
          source: 'migration',
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
    applyRemote: (recordId, value, metadata) => {
      return queueRemoteApply(store.stateKey, metadata, fence => (
        store.applyClassRecord(recordId, value, {
          source: metadata.source,
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
  };

  const savedDaysAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'saved-days',
    schemaVersion: 1,
    validate: value => store.isSavedDayValue(value),
    listLocal: () => store.listDayRecords(),
    writeLocal: (recordId, value, metadata) => {
      requireWriteSource(metadata);
      if (metadata.source === 'local') {
        return store.verifyCurrentDayRecord(recordId, value, {
          deleted: Boolean(metadata.deleted),
        });
      }
      return queueRemoteApply(store.daysKey, { source: 'migration' }, fence => (
        store.applyDayRecord(recordId, value, {
          source: 'migration',
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
    applyRemote: (recordId, value, metadata) => {
      return queueRemoteApply(store.daysKey, metadata, fence => (
        store.applyDayRecord(recordId, value, {
          source: metadata.source,
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const stageLocalChange = async detail => {
    await ready;
    if (detail.key === store.stateKey) {
      const changes = await store.diffStateRecords(detail.oldRaw, detail.newRaw);
      for (const change of changes.classes.filter(item => !item.deleted)) {
        await classesHandle.save(change.recordId, change.value);
      }
      if (changes.preferencesChanged) {
        await preferencesHandle.save(changes.preferences);
      }
      for (const change of changes.classes.filter(item => item.deleted)) {
        await classesHandle.remove(change.recordId);
      }
      return;
    }
    if (detail.key === store.daysKey) {
      const changes = await store.diffDayRecords(detail.oldRaw, detail.newRaw);
      for (const change of changes) {
        if (change.deleted) await daysHandle.remove(change.recordId);
        else await daysHandle.save(change.recordId, change.value);
      }
    }
  };

  const drainLocalStages = () => {
    if (stagingActive) return stagingDrain;
    stagingActive = true;
    stagingDrain = (async () => {
      while (pendingStages.size) {
        const [key, detail] = pendingStages.entries().next().value;
        pendingStages.delete(key);
        await stageLocalChange(detail);
      }
    })().finally(() => {
      stagingActive = false;
      if (pendingStages.size) void drainLocalStages();
    });
    return stagingDrain;
  };

  const enqueueLocalStage = detail => {
    const pending = pendingStages.get(detail.key);
    pendingStages.set(detail.key, pending
      ? { ...detail, oldRaw: pending.oldRaw }
      : { ...detail });
    return drainLocalStages();
  };

  if (store) {
    window.addEventListener(store.changeEvent, event => {
      const detail = event.detail;
      if (!detail || detail.source !== 'local') return;
      invalidatePreview();
      void enqueueLocalStage(detail).catch(error => {
        showAlert(
          `${error instanceof Error ? error.message : 'Synchronization staging failed.'} `
          + 'The change is still saved in this browser.'
        );
      });
    });
    window.addEventListener(store.errorEvent, event => {
      const message = event.detail?.message;
      if (message) showAlert(message);
    });
  }

  const updateApplyAvailability = () => {
    if (busy || !previewResult || previewResult.preview.writesPerformed !== 0) {
      applyButton.disabled = true;
      return;
    }
    const decisions = Array.from(records.querySelectorAll('select[data-record-key]'));
    const blocked = records.querySelector('[data-migration-blocked]');
    applyButton.disabled = Boolean(blocked)
      || previewResult.preview.remoteCount > 0
      || previewResult.preview.orphanedCount > 0
      || decisions.some(select => !select.value);
  };

  const friendlyRecordName = item => (
    item.collection === 'preferences'
      ? 'Tracker preferences'
      : item.collection === 'classes'
        ? `Class · ${item.recordId}`
        : `Saved day · ${item.recordId}`
  );

  const makeReviewRow = item => {
    const row = document.createElement('div');
    row.className = 'skill-sync-record';
    const identity = document.createElement('strong');
    identity.textContent = friendlyRecordName(item);
    const status = document.createElement('span');
    status.className = 'skill-sync-record-status';
    status.textContent = item.status.replaceAll('-', ' ');
    row.append(identity, status);

    if (item.status === 'content-conflict') {
      const label = document.createElement('label');
      label.textContent = item.remoteDeleted
        ? 'The synchronized record is deleted; preserve this device'
        : 'Choose the complete record';
      const select = document.createElement('select');
      select.dataset.recordKey = item.recordKey;
      select.innerHTML = item.remoteDeleted
        ? '<option value="">Choose…</option><option value="keep-local">Keep this device</option>'
        : `
          <option value="">Choose…</option>
          <option value="keep-local">Keep this device</option>
          <option value="accept-remote">Accept synchronized record</option>
        `;
      select.addEventListener('change', updateApplyAvailability);
      label.append(select);
      row.append(label);
    } else if (item.status === 'schema-conflict' && item.localPresent) {
      const label = document.createElement('label');
      label.textContent = 'This app cannot import the remote schema';
      const select = document.createElement('select');
      select.dataset.recordKey = item.recordKey;
      select.innerHTML = `
        <option value="">Choose…</option>
        <option value="keep-local">Keep this device</option>
      `;
      select.addEventListener('change', updateApplyAvailability);
      label.append(select);
      row.append(label);
    } else if (item.status === 'schema-conflict'
      || (item.status === 'remote-only' && item.remoteDeleted)) {
      const blocked = document.createElement('p');
      blocked.dataset.migrationBlocked = '';
      blocked.textContent =
        'This synchronized record cannot be applied safely. Local data was left unchanged.';
      row.append(blocked);
    }
    return row;
  };

  const renderPreview = result => {
    previewResult = result;
    review.hidden = false;
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · `
      + `${result.preview.conflictCount} conflict${result.preview.conflictCount === 1 ? '' : 's'} · `
      + `${result.preview.orphanedCount || 0} orphaned`;
    zeroWrite.textContent = result.preview.writesPerformed === 0
      ? 'Preview confirmed: 0 writes performed.'
      : 'Preview could not confirm zero writes. Migration is blocked.';
    zeroWrite.dataset.safe = String(result.preview.writesPerformed === 0);
    records.replaceChildren(...result.preview.review.map(makeReviewRow));
    if (result.preview.remoteCount > 0) {
      const blocked = document.createElement('p');
      blocked.dataset.migrationBlocked = '';
      blocked.textContent =
        'First-device migration is blocked because synchronized Skill Tracker records '
        + 'already exist. Local data was not changed.';
      records.prepend(blocked);
    }
    if (result.preview.orphanedCount > 0) {
      const blocked = document.createElement('p');
      blocked.dataset.migrationBlocked = '';
      blocked.textContent =
        `${result.preview.orphanedCount} orphaned synchronized record`
        + `${result.preview.orphanedCount === 1 ? '' : 's'} cannot be assigned safely. `
        + 'Migration is blocked; local data was not changed.';
      records.prepend(blocked);
    }
    if (!result.preview.review.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No registered local or synchronized records were found.';
      records.append(empty);
    }
    updateApplyAvailability();
  };

  const renderConflicts = async () => {
    if (!client) return;
    const renderId = ++conflictRender;
    const items = await client.listConflicts();
    if (renderId !== conflictRender) return;
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren();
    for (const item of items) {
      const parts = String(item.recordKey || '').split('\u001f');
      const collection = parts[2] || '';
      const recordId = parts[3] || '';
      const card = document.createElement('div');
      card.className = 'skill-sync-conflict';
      const title = document.createElement('strong');
      title.textContent = friendlyRecordName({ collection, recordId });
      const reason = document.createElement('span');
      reason.textContent = `Reason: ${item.reason || 'conflict'}`;
      const actions = document.createElement('div');
      actions.className = 'skill-sync-conflict-actions';
      const revision = Number.isInteger(item.current?.revision) ? item.current.revision : 0;
      const choices = [['Keep this device', 'keep-local']];
      if (item.current && !item.current.deleted) {
        choices.push(['Accept synchronized record', 'accept-remote']);
      }
      for (const [label, strategy] of choices) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = label;
        choice.addEventListener('click', () => {
          void runAction(async () => {
            await client.resolveConflict(item.recordKey, {
              strategy,
              expectedRemoteRevision: revision,
            });
            await renderConflicts();
          });
        });
        actions.append(choice);
      }
      card.append(title, reason, actions);
      conflictList.append(card);
    }
  };

  const showState = state => {
    const mode = state?.mode || 'disconnected';
    openButton.dataset.state = mode;
    openButton.title = state?.message || 'Open sync and backup';
    stateBox.dataset.state = mode;
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent =
      state?.message || 'Local Skill Tracker data remains on this device.';
    connectButton.hidden = mode !== 'disconnected';
    syncButton.hidden = !['synced', 'offline', 'conflict'].includes(mode);
    previewButton.hidden = mode !== 'review';
    disconnectButton.hidden = mode === 'disconnected';
    resetButton.hidden = mode !== 'disconnected';
    if (mode === 'conflict') void renderConflicts();
    else {
      conflictRender += 1;
      conflicts.hidden = true;
      conflictList.replaceChildren();
    }
  };

  const runAction = async action => {
    if (busy) return;
    showAlert('');
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'The action could not be completed safely.');
    } finally {
      setBusy(false);
    }
  };

  const initialize = async () => {
    if (!store) throw new Error('The Skill Tracker local data store did not load.');
    const inspected = store.inspect();
    const invalid = Object.values(inspected).find(item => item.status === 'invalid');
    if (invalid) throw invalid.error;
    const recoverable = Object.values(inspected).filter(
      item => item.status === 'recoverable'
    );
    recoveryButton.hidden = recoverable.length === 0;
    if (recoverable.length) {
      throw new Error(
        `Recognized ${recoverable.map(item => item.format).join(' and ')} data. `
        + 'Download the exact raw backup and use the historical-data recovery action; '
        + 'synchronization remains blocked until then.'
      );
    }
    if (!window.RyanAppSync?.create) {
      throw new Error('Ryan App Sync is unavailable. Exact raw local backup still works.');
    }
    client = window.RyanAppSync.create({
      appId: APP_ID,
      manifestVersion: MANIFEST_VERSION,
      deviceLabel: `Skill Tracker · ${navigator.platform || 'browser'}`,
      showStatus: false,
    });
    client.onStateChange(showState);
    preferencesHandle = await client.register(preferencesAdapter);
    classesHandle = await client.registerCollection(classesAdapter);
    daysHandle = await client.registerCollection(savedDaysAdapter);
    await client.finalizeRegistration();
    initialized = true;
    recoveryButton.hidden = true;
    showState(client.getState());
  };

  const beginInitialize = () => {
    ready = initialize().catch(error => {
    showAlert(error instanceof Error ? error.message : 'Ryan App Sync could not initialize.');
    stateMessage.textContent =
      'Exact raw local backup remains available; synchronization is unavailable.';
    connectButton.hidden = true;
    syncButton.hidden = true;
    previewButton.hidden = true;
    disconnectButton.hidden = true;
    throw error;
  });
    ready.catch(() => {});
    return ready;
  };
  beginInitialize();

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    const error = store?.getLastError?.();
    showAlert(error ? error.message : '');
    if (!dialog.open) dialog.showModal();
    closeButton.focus();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    restoreFocus?.focus?.();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.connect();
    });
  });

  syncButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.sync();
      await renderConflicts();
    });
  });

  localBackupButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      if (initialized) await client.exportBackup(true);
      else showAlert('Exact raw local backup downloaded. Safe sync is unavailable on this page.');
    });
  });

  recoveryButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      const normalized = await store.normalizeRecoverable({ backupConfirmed: true });
      if (!normalized.length) {
        throw new Error('No recognized historical Skill Tracker data needs normalization.');
      }
      initialized = false;
      client = null;
      preferencesHandle = null;
      classesHandle = null;
      daysHandle = null;
      await beginInitialize();
      showAlert(
        'Exact raw backup downloaded and recognized historical data normalized safely.'
      );
    });
  });

  previewButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      await ready;
      renderPreview(await client.previewMigration({
        sourceKey: 'skill-tracker-browser-v1',
        downloadBackup: true,
      }));
    });
  });

  applyButton.addEventListener('click', () => {
    void runAction(async () => {
      if (!previewResult || previewResult.preview.writesPerformed !== 0) {
        throw new Error('Create and review a fresh zero-write migration preview.');
      }
      if (previewResult.preview.remoteCount > 0) {
        throw new Error(
          'First-device migration is blocked because synchronized Skill Tracker records exist.'
        );
      }
      if (previewResult.preview.orphanedCount > 0) {
        throw new Error(
          'Migration is blocked because orphaned synchronized records need review.'
        );
      }
      const resolutions = {};
      records.querySelectorAll('select[data-record-key]').forEach(select => {
        if (select.value) resolutions[select.dataset.recordKey] = select.value;
      });
      await client.applyMigration(previewResult.plan, resolutions);
      invalidatePreview();
      await renderConflicts();
    });
  });

  disconnectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.disconnect();
      invalidatePreview();
    });
  });

  resetButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.resetDevice();
      invalidatePreview();
      showAlert(
        'Device connection reset. Local Skill Tracker data was preserved; '
        + 'connect again and review a fresh preview.'
      );
    });
  });

  window.SkillTrackerSync = Object.freeze({
    appId: APP_ID,
    manifestVersion: MANIFEST_VERSION,
    get ready() {
      return ready;
    },
    open: () => openButton.click(),
    rawBackup: () => store.rawBackup(),
  });
})();
