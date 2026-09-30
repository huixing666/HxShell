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
  const queued = [], requests = [], unmount = []
  const api = {
    getFileContent(connId, path, progress) {
      return new Promise((resolve) => requests.push({ progress, resolve }))
    },
    fileStat: async () => ({ size: 3, mtime: 'initial' }),
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
    source + '\nreturn { tabs, cms, hostEls, addTab, closeTab, pollTick };')
  const state = setup({ ...vue, nextTick: (cb) => queued.push(cb), onMounted() {},
    onBeforeUnmount: (cb) => unmount.push(cb), watch() {} }, api, createEditor,
    () => ({ open: true }), () => () => {}, { success() {} }, {}, { now: () => 1000 })
  async function open() {
    state.addTab('connection-a', '/test.txt')
    state.hostEls['connection-a::/test.txt'] = {}
    const load = queued.shift()()
    await Promise.resolve()
    await Promise.resolve()
    return { load, tab: state.tabs.value.at(-1), request: requests.at(-1) }
  }
  return { ...state, open, api, unmount: () => unmount.forEach((cb) => cb()), requests }
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


