/* Sessionscope storage — IndexedDB key/value, no deps, no network.
 * Replaces sessionStorage (~5 MB cap) with IndexedDB (~GB-scale per origin).
 * Same privacy posture: data lives in the user's browser, never leaves. */
(function (global) {
  const DB = "sessionscope";
  const STORE = "kv";
  const VERSION = 1;
  let dbPromise = null;

  function openDB(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(DB, VERSION); }
      catch(e){ rej(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error("indexedDB.open failed"));
      req.onblocked = () => rej(new Error("indexedDB blocked"));
    });
    return dbPromise;
  }
  function tx(mode){ return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE)); }
  function wrap(req){ return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

  async function idbSet(key, val){ const s = await tx("readwrite"); return wrap(s.put(val, key)); }
  async function idbGet(key){      const s = await tx("readonly");  return wrap(s.get(key)); }
  async function idbDel(key){      const s = await tx("readwrite"); return wrap(s.delete(key)); }
  async function idbClear(){       const s = await tx("readwrite"); return wrap(s.clear()); }
  async function idbHas(key){      const v = await idbGet(key); return v !== undefined; }
  async function idbKeys(){        const s = await tx("readonly");  return wrap(s.getAllKeys()); }

  // Returns the storage quota estimate (bytes) so we can show "you have X GB available".
  async function idbQuota(){
    try{
      if(navigator.storage && navigator.storage.estimate){
        const e = await navigator.storage.estimate();
        return { usage: e.usage||0, quota: e.quota||0 };
      }
    }catch(_){}
    return { usage:0, quota:0 };
  }

  global.SSStore = { idbSet, idbGet, idbDel, idbClear, idbHas, idbKeys, idbQuota };
})(window);
