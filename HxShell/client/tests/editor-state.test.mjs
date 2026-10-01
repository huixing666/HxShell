import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as vue from 'vue'

// Run real component handlers with controlled network and DOM boundaries.
const source = readFileSync(new URL('../src/components/EditorModal.vue', import.meta.url), 'utf8')
  .split('<script setup>')[1].split('</script>')[0]
  .replace(/^import .*$/gm, '')
  .replace("await import('../cmEditor.js')", 'await Promise.resolve({ createEditor: makeEditor })')

function fixture() {
  const queued = [], requests = [], unmount = [], saves = [], events = []
  const props = vue.reactive({ open: true, connections: [{ uid: 'stable-a', connectionId: 'connection-a' }, { uid: 'stable-b', connectionId: 'connection-b' }] })
  const api = {
    getFileContent(connId, path, progress, signal) {
      return new Promise((resolve) => requests.push({ connId, path, progress, resolve, signal }))
    },
    fileStat: async () => ({ size: 3, mtime: 'initial' }),
    saveFileContent: async (connId, path, content) => { saves.push({ connId, path, content }) },
  }
  function createEditor(options) {
    let doc = ''
    return {
      setDoc: (value) => { doc = value }, append: (value) => { doc += value },
      getDoc: () => doc, lines: () => doc.split('\n').length,
      setReadOnly() {}, setWrap() {}, setLanguage() {}, focus() {}, destroy() {},
      type: (value) => { doc += value; options.onChange() },
    }
  }
  const setup = new Function('vue', 'api', 'makeEditor', 'defineProps', 'defineEmits', 'ElMessage', 'ElMessageBox', 'performance',
    'const { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } = vue;\n' +
    source + '\nreturn { tabs, cms, hostEls, addTab, closeTab, pollTick, saveTab, saveAndExit: typeof saveAndExit === "function" ? saveAndExit : undefined };')
  const state = setup({ ...vue, nextTick: (cb) => queued.push(cb), onMounted() {},
    onBeforeUnmount: (cb) => unmount.push(cb), watch: (...args) => { unmount.push(vue.watch(...args)) } }, api, createEditor,
    () => props, () => (event) => events.push(event), { success() {} }, {}, { now: () => 1000 })
  async function open(connId = 'connection-a', path = '/test.txt', uid) {
    state.addTab(connId, path, uid)
    state.hostEls[state.tabs.value.at(-1).key] = {}
    const load = queued.shift()()
    await Promise.resolve()
    await Promise.resolve()
    return { load, tab: state.tabs.value.at(-1), request: requests.at(-1) }
  }
  return { ...state, open, api, props, saves, events, queued, unmount: () => unmount.forEach((cb) => cb()), requests }
}

test('typing immediately updates dirty state through Vue reactivity', async () => {
  const f = fixture()
  const opened = await f.open()
  opened.request.resolve({ content: 'old' })
  await opened.load
  let visibleDirty = false
  const stop = vue.watchEffect(() => { visibleDirty = opened.tab.dirty }, { flush: 'sync' })
  f.cms.get(opened.tab.key).type('edit')
  assert.equal(visibleDirty, true)
  stop()
  f.unmount()
})

test('old streaming read cannot append into a reopened file', async () => {
  const f = fixture()
  const old = await f.open()
  f.closeTab(old.tab)
  const reopened = await f.open()
  reopened.request.resolve({ content: 'new' })
  await reopened.load
  old.request.progress({ loaded: 3, total: 3, percent: 100, chunk: 'OLD' })
  old.request.resolve({ content: 'old' })
  await old.load
  assert.equal(f.cms.get(reopened.tab.key).getDoc(), 'new')
  f.unmount()
})

test('remote stat response cannot overwrite edits made while polling', async () => {
  const f = fixture()
  const opened = await f.open()
  opened.request.resolve({ content: 'old' })
  await opened.load
  opened.tab.autoRefresh = true
  let resolveStat
  f.api.fileStat = () => new Promise((resolve) => { resolveStat = resolve })
  const poll = f.pollTick()
  f.cms.get(opened.tab.key).type('local')
  resolveStat({ size: 99, mtime: 'changed' })
  await Promise.resolve()
  // Old code starts a new read and would otherwise leave the test awaiting it.
  f.requests.slice(1).forEach((request) => request.resolve({ content: 'remote' }))
  await poll
  assert.equal(f.cms.get(opened.tab.key).getDoc(), 'oldlocal')
  assert.equal(opened.tab.changedRemote, true)
  f.unmount()
})

test('opening another SSH connection preserves retained editor tabs', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const handler = app.slice(app.indexOf('function handleConnected('), app.indexOf('async function disconnectConn('))
  const editor = vue.ref({ open: false, keepAlive: true, connId: 'a', path: '/unsaved', seq: 1 })
  const run = new Function('editor', 'connections', 'activeId', 'connectVisible', 'cwdMap', 'broken',
    'toConn', 'loadSaved', 'persistWorkspace', handler + '\nhandleConnected({ connectionId: "b" });')
  run(editor, vue.ref([]), vue.ref('a'), vue.ref(true), {}, vue.ref([]), (x) => x, () => {}, () => {})
  assert.equal(editor.value.keepAlive, true)
  assert.equal(editor.value.path, '/unsaved')
})



test('reconnect keeps the document and saves through the new session without duplicating tabs', async () => {
  const f = fixture()
  const opened = await f.open('connection-a', '/test.txt', 'stable-a')
  opened.request.resolve({ content: 'old' })
  await opened.load
  const cm = f.cms.get(opened.tab.key)
  cm.type('local')
  f.props.connections[0].connectionId = 'connection-new'
  await vue.nextTick()
  await f.saveTab(opened.tab)
  assert.deepEqual(f.saves.at(-1), { connId: 'connection-new', path: '/test.txt', content: 'oldlocal' })
  f.addTab('connection-new', '/test.txt', 'stable-a')
  assert.equal(f.tabs.value.length, 1)
  assert.equal(f.cms.get(opened.tab.key), cm)
  assert.equal(cm.getDoc(), 'oldlocal')
  f.unmount()
})

test('same path in two SSH tabs remains independent', async () => {
  const f = fixture()
  const a = await f.open('connection-a', '/test.txt', 'stable-a')
  a.request.resolve({ content: 'a' })
  await a.load
  const b = await f.open('connection-b', '/test.txt', 'stable-b')
  b.request.resolve({ content: 'b' })
  await b.load
  f.props.connections[0].connectionId = 'connection-new'
  await vue.nextTick()
  await f.saveTab(a.tab)
  await f.saveTab(b.tab)
  assert.equal(f.saves[0].connId, 'connection-new')
  assert.equal(f.saves[1].connId, 'connection-b')
  assert.equal(f.tabs.value.length, 2)
  f.unmount()
})

test('save and exit closes only the saved file, and the last file exits the dialog', async () => {
  const f = fixture()
  const a = await f.open()
  a.request.resolve({ content: 'a' })
  await a.load
  const b = await f.open('connection-b', '/second.txt', 'stable-b')
  b.request.resolve({ content: 'b' })
  await b.load
  f.cms.get(a.tab.key).type('edit')
  await f.saveAndExit(a.tab)
  assert.equal(f.tabs.value.length, 1)
  assert.equal(f.tabs.value[0], b.tab)
  assert.equal(f.events.length, 0)
  await f.saveAndExit(b.tab)
  assert.equal(f.tabs.value.length, 0)
  assert.deepEqual(f.events, ['close'])
  f.unmount()
})

test('failed save and exit retains document and dirty state', async () => {
  const f = fixture()
  const opened = await f.open()
  opened.request.resolve({ content: 'old' })
  await opened.load
  f.cms.get(opened.tab.key).type('local')
  f.api.saveFileContent = async () => { throw new Error('offline') }
  await f.saveAndExit(opened.tab)
  assert.equal(f.tabs.value.length, 1)
  assert.equal(f.cms.get(opened.tab.key).getDoc(), 'oldlocal')
  assert.equal(opened.tab.dirty, true)
  assert.equal(opened.tab.error, 'offline')
  assert.equal(f.events.length, 0)
  f.unmount()
})

test('typing during save does not let save and exit discard newer edits', async () => {
  const f = fixture()
  const opened = await f.open()
  opened.request.resolve({ content: 'old' })
  await opened.load
  f.cms.get(opened.tab.key).type('first')
  let resolveSave
  f.api.saveFileContent = () => new Promise((resolve) => { resolveSave = resolve })
  const saving = f.saveAndExit(opened.tab)
  f.cms.get(opened.tab.key).type('second')
  resolveSave()
  await saving
  assert.equal(opened.tab.dirty, true)
  assert.equal(f.cms.get(opened.tab.key).getDoc(), 'oldfirstsecond')
  assert.equal(f.tabs.value.length, 1)
  f.unmount()
})

test('old session polling result is ignored after reconnect', async () => {
  const f = fixture()
  const opened = await f.open('connection-a', '/test.txt', 'stable-a')
  opened.request.resolve({ content: 'old' })
  await opened.load
  opened.tab.autoRefresh = true
  let resolveStat
  f.api.fileStat = () => new Promise((resolve) => { resolveStat = resolve })
  const poll = f.pollTick()
  f.props.connections[0].connectionId = 'connection-new'
  await vue.nextTick()
  f.api.fileStat = async () => ({ size: 3, mtime: 'initial' })
  resolveStat({ size: 99, mtime: 'old-session-result' })
  await Promise.resolve()
  f.requests.slice(1).forEach((request) => request.resolve({ content: 'STALE' }))
  await poll
  assert.equal(f.cms.get(opened.tab.key).getDoc(), 'old')
  assert.equal(f.requests.length, 1)
  f.unmount()
})

test('reconnect while reading restarts only the unfinished read and ignores old chunks', async () => {
  const f = fixture()
  const old = await f.open('connection-a', '/test.txt', 'stable-a')
  f.props.connections[0].connectionId = 'connection-new'
  await vue.nextTick()
  const resumed = f.queued.shift()()
  await Promise.resolve()
  await Promise.resolve()
  const current = f.requests.at(-1)
  assert.equal(current.connId, 'connection-new')
  assert.equal(old.request.signal.aborted, true)
  current.resolve({ content: 'new' })
  await resumed
  old.request.progress({ loaded: 3, total: 3, percent: 100, chunk: 'OLD' })
  old.request.resolve({ content: 'old' })
  await old.load
  assert.equal(f.cms.get(old.tab.key).getDoc(), 'new')
  assert.equal(f.tabs.value.length, 1)
  f.unmount()
})

test('reconnect during save keeps the file open until it is saved through the new session', async () => {
  const f = fixture()
  const opened = await f.open('connection-a', '/test.txt', 'stable-a')
  opened.request.resolve({ content: 'old' })
  await opened.load
  f.cms.get(opened.tab.key).type('local')
  let resolveSave
  f.api.saveFileContent = () => new Promise((resolve) => { resolveSave = resolve })
  const saving = f.saveAndExit(opened.tab)
  f.props.connections[0].connectionId = 'connection-new'
  await vue.nextTick()
  resolveSave()
  await saving
  assert.equal(f.tabs.value.length, 1)
  assert.equal(opened.tab.dirty, true)
  f.api.saveFileContent = async (connId, path, content) => f.saves.push({ connId, path, content })
  await f.saveAndExit(opened.tab)
  assert.equal(f.tabs.value.length, 0)
  assert.equal(f.saves.at(-1).connId, 'connection-new')
  f.unmount()
})

test('App opens files with a stable SSH tab identity before and after reconnect', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const handler = app.slice(app.indexOf('function openEditor('), app.indexOf('function closeEditor('))
  const connections = vue.ref([{ uid: 'stable-a', connectionId: 'old-id' }])
  const editor = vue.ref({ seq: 0 })
  const run = new Function('editor', 'connections', handler + '\nreturn openEditor;')
  const openEditor = run(editor, connections)
  openEditor('old-id', '/test.txt')
  assert.equal(editor.value.connectionUid, 'stable-a')
  connections.value[0].connectionId = 'new-id'
  openEditor('new-id', '/test.txt')
  assert.equal(editor.value.connectionUid, 'stable-a')
  assert.equal(editor.value.connId, 'new-id')
})
