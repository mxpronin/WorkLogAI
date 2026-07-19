const DATABASE_NAME = 'worklog-ai';
const DATABASE_VERSION = 2;

let databasePromise;

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}

export function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener('upgradeneeded', () => {
      const database = request.result;

      if (!database.objectStoreNames.contains('tasks')) {
        const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
        tasks.createIndex('spprNumber', 'spprNumber', { unique: false });
        tasks.createIndex('status', 'status', { unique: false });
        tasks.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!database.objectStoreNames.contains('workDays')) {
        const workDays = database.createObjectStore('workDays', { keyPath: 'id' });
        workDays.createIndex('localDate', 'localDate', { unique: true });
      }

      if (!database.objectStoreNames.contains('workEntries')) {
        const entries = database.createObjectStore('workEntries', { keyPath: 'id' });
        entries.createIndex('taskId', 'taskId', { unique: false });
        entries.createIndex('localDate', 'localDate', { unique: false });
        entries.createIndex('taskDate', ['taskId', 'localDate'], { unique: false });
        entries.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      const entries = request.transaction.objectStore('workEntries');
      if (!entries.indexNames.contains('submissionKey')) {
        entries.createIndex('submissionKey', 'submissionKey', { unique: true });
      }

      if (!database.objectStoreNames.contains('entryRevisions')) {
        const revisions = database.createObjectStore('entryRevisions', { keyPath: 'id' });
        revisions.createIndex('workEntryId', 'workEntryId', { unique: false });
      }

      if (!database.objectStoreNames.contains('audioAttachments')) {
        const attachments = database.createObjectStore('audioAttachments', { keyPath: 'id' });
        attachments.createIndex('workEntryId', 'workEntryId', { unique: false });
      }

      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
    });

    request.addEventListener('success', () => {
      const database = request.result;
      database.addEventListener('versionchange', () => database.close());
      resolve(database);
    }, { once: true });

    request.addEventListener('blocked', () => {
      reject(new Error('Закройте другие вкладки WorkLog AI и обновите страницу.'));
    }, { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });

  return databasePromise;
}

export async function runTransaction(storeNames, mode, operation) {
  const database = await openDatabase();
  const transaction = database.transaction(storeNames, mode);
  const completion = transactionToPromise(transaction);
  const result = await operation(transaction);
  await completion;
  return result;
}
