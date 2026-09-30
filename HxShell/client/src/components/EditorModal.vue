<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'

// 多文件编辑器：一个弹窗里多条文件标签，每条一个独立的 CodeMirror 实例。
// 实例常驻（v-show 切换，不销毁），各自的滚动位置 / 撤销历史 / 未保存状态都保留。
// 弹窗关闭只隐藏（open=false），标签继续保留，下次打开接着编辑；只有 App 真正卸载
// 组件（登出/断开清理）时才销毁全部实例。
const props = defineProps({
  connId: String, // 新开标签所属连接（App 每次 openEditor 传入，各标签记住自己的）
  path: String,   // 新开的文件路径
  seq: Number,    // openEditor 计数，驱动 watch 新开标签（同文件已开则只切换）
  open: Boolean,  // 弹窗显隐
})
const emit = defineEmits(['close'])

// { key, connId, path, loading, saving, error, saved, dirty, wrap, lines,
//   autoRefresh, changedRemote, progress, progressText, statReady, statSize, statMtime, polling }
const tabs = ref([])
const activeKey = ref(null)
const activeTab = computed(() => tabs.value.find((t) => t.key === activeKey.value) || null)

// CodeMirror 句柄与挂载 DOM 故意不放响应式：编辑器实例不需要被代理
const cms = new Map() // key -> cm handle
const loadControllers = new Map() // key -> 当前读取的取消源（关闭/重读时取消）
const hostEls = {}    // key -> 容器 DOM（template ref 函数写入）

const fname = (p) => String(p || '').split('/').pop()

async function ensureEditor(t) {
  if (!tabs.value.includes(t)) return null
  if (cms.get(t.key)) return cms.get(t.key)
  // 编辑器走动态 import：不打开这个弹窗就不会下载 CodeMirror 那个 chunk
  const { createEditor } = await import('../cmEditor.js')
  if (!tabs.value.includes(t)) return null
  const host = hostEls[t.key]
  if (!host) return null // 等 import 的间隙里标签被关了
  const cm = createEditor({
    parent: host,
    readOnly: true, // 加载期只读，读完再解锁
    onSave: () => { if (!t.loading && !t.saving) saveTab(t) },
    onChange: () => { t.dirty = true; t.saved = false; t.lines = cms.get(t.key)?.lines() || 0 },
  })
  cm.setWrap(t.wrap)
  cms.set(t.key, cm)
  return cm
}

// 记录 size/mtime 基线：自动刷新用它对比「加载/保存之后」文件是否又被外部改动
async function refreshBaseline(t) {
  try {
    const st = await api.fileStat(t.connId, t.path)
    t.statReady = true
    t.statSize = st.size
    t.statMtime = st.mtime
  } catch (_) { t.statReady = false /* 文件可能刚被删，静默 */ }
}

async function loadTab(t) {
  if (!tabs.value.includes(t) || t.saving) return
  loadControllers.get(t.key)?.abort()
  const controller = new AbortController()
  loadControllers.set(t.key, controller)
  const isCurrent = () => tabs.value.includes(t) && loadControllers.get(t.key) === controller
  paintBufs.delete(t.key)
  t.loading = true
  t.error = ''
  t.saved = false
  t.dirty = false
  t.changedRemote = false
  t.progress = 0
  t.progressText = ''
  try {
    const ed = await ensureEditor(t)
    if (!ed || !isCurrent()) return
    ed.setDoc('')
    ed.setReadOnly(true)
    ed.setLanguage(t.path)
    const res = await api.getFileContent(t.connId, t.path, ({ loaded, total, percent, chunk }) => {
      if (!isCurrent()) return
      t.progress = percent
      const mb = (n) => (n / 1024 / 1024).toFixed(1)
      t.progressText = total
        ? `读取中… ${percent}%（${mb(loaded)} / ${mb(total)} MB）`
        : `读取中… ${mb(loaded)} MB`
      pendingAppend(t, chunk)
    }, controller.signal)
    if (!isCurrent()) return
    ed.setDoc(res.content)
    t.lines = ed.lines()
    await refreshBaseline(t)
  } catch (e) {
    if (isCurrent()) t.error = e.message
  } finally {
    if (isCurrent()) {
      loadControllers.delete(t.key)
      paintBufs.delete(t.key)
      t.loading = false
      const ed = cms.get(t.key)
      if (ed && !t.error) {
        ed.setReadOnly(false)
        if (activeKey.value === t.key) ed.focus()
      }
    }
  }
}

// 流式 chunk 先攒着，节流 ~120ms 刷一次，避免每个块都单独发一次事务
const paintBufs = new Map() // key -> { parts: [], lastPaint: 0 }
function pendingAppend(t, chunk) {
  let buf = paintBufs.get(t.key)
  if (!buf) { buf = { parts: [], lastPaint: 0 }; paintBufs.set(t.key, buf) }
  buf.parts.push(chunk)
  const ed = cms.get(t.key)
  if (!ed) return
  if (performance.now() - buf.lastPaint > 120) {
    ed.append(buf.parts.join(''))
    buf.parts = []
    buf.lastPaint = performance.now()
    t.lines = ed.lines()
  }
}

async function saveTab(t) {
  const ed = cms.get(t.key)
  if (!ed || t.loading || t.saving) return
  t.saving = true
  t.error = ''
  t.saved = false
  try {
    await api.saveFileContent(t.connId, t.path, ed.getDoc())
    t.saved = true
    t.dirty = false
    t.changedRemote = false
    await refreshBaseline(t) // 自己的保存不算「外部修改」，重记基线
    ElMessage.success(`已保存 ${fname(t.path)}`)
  } catch (e) {
    t.error = e.message
  } finally {
    t.saving = false
  }
}

// ---- 标签管理 ----

function addTab(connId, path) {
  if (!path) return
  const key = `${connId}::${path}`
  const existed = tabs.value.find((x) => x.key === key)
  if (existed) { activeKey.value = key; return } // 已开着：只切换，不重复开
  const t = reactive({
    key, connId, path,
    loading: false, saving: false, error: '', saved: false, dirty: false,
    wrap: false, lines: 0,
    autoRefresh: false, changedRemote: false,
    progress: 0, progressText: '',
    statReady: false, statSize: 0, statMtime: '', polling: false,
  })
  tabs.value.push(t)
  activeKey.value = key
  // 等 pane 渲染出挂载点再加载（hostEls 在 render 后才有值）
  nextTick(() => loadTab(t))
}

function closeTab(t) {
  const doClose = () => {
    if (!tabs.value.includes(t)) return
    loadControllers.get(t.key)?.abort()
    loadControllers.delete(t.key)
    cms.get(t.key)?.destroy()
    cms.delete(t.key)
    paintBufs.delete(t.key)
    delete hostEls[t.key]
    const i = tabs.value.indexOf(t)
    tabs.value.splice(i, 1)
    if (activeKey.value === t.key) {
      const next = tabs.value[Math.min(i, tabs.value.length - 1)]
      activeKey.value = next ? next.key : null
    }
    if (!tabs.value.length) emit('close') // 最后一个标签关掉 = 关弹窗
  }
  if (!t.dirty || t.loading) { doClose(); return }
  ElMessageBox.confirm(`「${fname(t.path)}」有未保存的修改，直接关闭将丢失这些改动。`, '未保存的修改', {
    confirmButtonText: '保存并关闭',
    cancelButtonText: '直接关闭',
    distinguishCancelAndClose: true,
    type: 'warning',
  })
    .then(async () => {
      await saveTab(t)
      if (!t.error) doClose() // 保存失败留在编辑器里处理错误
    })
    .catch((action) => {
      if (action === 'cancel') doClose() // 「直接关闭」；close（Esc/X）= 取消，留在编辑器
    })
}

// 弹窗关闭守卫：任一标签有未保存修改时先询问。「保存并关闭」会依次保存全部脏标签，
// 任一保存失败（error 置位）不关闭；Esc / X 掉确认框留在编辑器。
function guardClose(done) {
  const dirtyTabs = tabs.value.filter((t) => t.dirty && !t.loading)
  if (!dirtyTabs.length) { done(); return }
  const label = dirtyTabs.length === 1 ? `「${fname(dirtyTabs[0].path)}」` : `${dirtyTabs.length} 个文件`
  ElMessageBox.confirm(`${label}有未保存的修改，直接关闭将丢失这些改动。`, '未保存的修改', {
    confirmButtonText: '保存并关闭',
    cancelButtonText: '直接关闭',
    distinguishCancelAndClose: true,
    type: 'warning',
  })
    .then(async () => {
      for (const t of dirtyTabs) await saveTab(t)
      if (!dirtyTabs.some((t) => t.error)) done()
    })
    .catch((action) => {
      if (action === 'cancel') done()
    })
}

// ---- 自动刷新：轮询远端 size/mtime ----
let pollTimer = null
const POLL_MS = 3000

async function pollTick() {
  if (!props.open) return // 弹窗隐藏时不轮询
  for (const t of tabs.value) {
    if (!t.autoRefresh || !t.statReady || t.loading || t.saving || t.polling) continue
    t.polling = true
    try {
      const st = await api.fileStat(t.connId, t.path)
      if (!tabs.value.includes(t) || !props.open || !t.autoRefresh || t.loading || t.saving) continue
      if (st.size !== t.statSize || st.mtime !== t.statMtime) {
        if (!t.dirty) {
          await loadTab(t) // 无本地改动：直接重读（loadTab 会重记基线）
        } else {
          t.changedRemote = true // 有未保存改动：不覆盖，提示条 + 手动重新加载
        }
      }
    } catch (_) { /* 文件被删 / 连接断了：静默，下轮再试 */ }
    finally { t.polling = false }
  }
}

// 有未保存改动时检测到外部修改：手动重新加载要确认（丢弃本地改动）
function reloadConfirm(t) {
  ElMessageBox.confirm(`重新加载将丢弃「${fname(t.path)}」的本地未保存修改。`, '重新加载', {
    confirmButtonText: '重新加载',
    cancelButtonText: '取消',
    type: 'warning',
  })
    .then(() => loadTab(t))
    .catch(() => {})
}

// 自动换行是每标签状态：切换标签 / 勾选时应用到对应编辑器
watch(() => activeTab.value?.wrap, (v, old) => {
  const t = activeTab.value
  if (!t || !cms.get(t.key)) return
  if (v !== old) cms.get(t.key).setWrap(v)
})

// App 的 openEditor 计数变化 = 请求新开（或切换到）一个文件
watch(() => props.seq, () => addTab(props.connId, props.path))

onMounted(() => {
  addTab(props.connId, props.path)
  pollTimer = setInterval(pollTick, POLL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  for (const controller of loadControllers.values()) controller.abort()
  loadControllers.clear()
  tabs.value = []
  for (const cm of cms.values()) cm.destroy()
  cms.clear()
})
</script>

<template>
  <el-dialog
    :model-value="open"
    width="min(1100px, 94vw)"
    top="6vh"
    :show-close="true"
    :close-on-click-modal="false"
    :before-close="guardClose"
    @close="emit('close')"
  >
    <template #header>
      <div class="dlg-head">
        <span class="title" :title="activeTab?.path">{{ activeTab?.path }}</span>
        <span v-if="activeTab?.dirty" class="warn">● 未保存</span>
        <span v-else-if="activeTab?.saved" class="ok">已保存 ✓</span>
      </div>
    </template>

    <!-- 文件标签：多于一个文件时出现，可切换 / 单独关闭 -->
    <div v-if="tabs.length > 1" class="etabs">
      <div
        v-for="t in tabs"
        :key="t.key"
        class="etab"
        :class="{ active: t.key === activeKey }"
        :title="t.path"
        @click="activeKey = t.key"
      >
        <span class="etab-name">{{ fname(t.path) }}</span>
        <span v-if="t.dirty" class="etab-dot dirty" title="未保存">●</span>
        <span v-else-if="t.changedRemote" class="etab-dot remote" title="服务器上已被修改">●</span>
        <el-icon class="etab-close" title="关闭该文件" @click.stop="closeTab(t)"><Close /></el-icon>
      </div>
    </div>

    <!-- 每个文件一个 pane；v-show 切换，CodeMirror 实例常驻 -->
    <div
      v-for="t in tabs"
      v-show="t.key === activeKey"
      :key="'pane-' + t.key"
      class="pane"
      :class="{ 'with-tabs': tabs.length > 1 }"
    >
      <el-alert
        v-if="t.error"
        :title="t.error"
        type="error"
        :closable="false"
        show-icon
        class="mb"
      />
      <el-alert v-if="t.changedRemote" type="warning" :closable="false" show-icon class="mb">
        <template #title>
          <span class="remote-msg">
            文件在服务器上已被修改；本地有未保存修改，未自动覆盖。
            <el-button size="small" type="warning" plain class="reload-btn" @click="reloadConfirm(t)">重新加载</el-button>
          </span>
        </template>
      </el-alert>

      <div v-if="t.loading" class="loading">
        <el-progress :percentage="t.progress" :stroke-width="6" :show-text="false" />
        <div class="loading-tip">{{ t.progressText }}</div>
      </div>

      <!-- CodeMirror 挂在这里；高度固定，滚动交给编辑器自己（不要再套 autosize） -->
      <div :ref="(el) => { if (el) hostEls[t.key] = el }" class="editor-host"></div>
    </div>

    <template #footer>
      <div v-if="activeTab" class="foot">
        <div class="foot-left">
          <el-button size="small" :disabled="activeTab.loading" @click="cms.get(activeTab.key)?.openSearch()">查找 / 替换</el-button>
          <el-checkbox v-model="activeTab.wrap" size="small" :disabled="activeTab.loading">自动换行</el-checkbox>
          <el-checkbox
            v-model="activeTab.autoRefresh"
            size="small"
            :disabled="activeTab.loading"
            title="每 3 秒检查服务器上该文件，有变更自动重新加载；本地有未保存修改时不覆盖，仅在顶部提示"
          >自动刷新</el-checkbox>
          <span class="hint">{{ activeTab.lines }} 行 · Ctrl+F 查找 · Alt+G 跳转行 · Ctrl+S 保存</span>
        </div>
        <div class="foot-right">
          <el-button @click="guardClose(() => emit('close'))">关闭</el-button>
          <el-button type="primary" :loading="activeTab.saving" :disabled="activeTab.loading" @click="saveTab(activeTab)">
            {{ activeTab.saving ? '保存中…' : '保存 (Ctrl+S)' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.dlg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #1f2d3d;
  font-family: ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ok {
  color: #2ecc71;
  font-size: 12px;
  flex-shrink: 0;
}
.warn {
  color: #e6a23c;
  font-size: 12px;
  flex-shrink: 0;
}
.mb {
  margin-bottom: 12px;
}
.remote-msg {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.reload-btn {
  margin-left: 4px;
}
/* 文件标签条（多文件时显示），风格对齐 sess-tab */
.etabs {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 1px;
  margin-bottom: -1px;
}
.etab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 10px;
  border: 1px solid var(--border);
  border-radius: 7px 7px 0 0;
  background: #f7f9fc;
  color: #5b6b7b;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
  max-width: 220px;
}
.etab.active {
  background: #fff;
  color: #1f2d3d;
  font-weight: 600;
  border-bottom-color: #fff; /* 与下方编辑区视觉相连 */
}
.etab-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.etab-dot {
  font-size: 10px;
  line-height: 1;
  flex-shrink: 0;
}
.etab-dot.dirty {
  color: #e6a23c;
}
.etab-dot.remote {
  color: #e5484d;
}
.etab-close {
  flex-shrink: 0;
  font-size: 12px;
  color: #a0acb9;
  border-radius: 3px;
}
.etab-close:hover {
  color: #e5484d;
  background: #f0f2f5;
}
.loading {
  padding: 0 0 8px;
}
.loading-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #8a97a5;
  text-align: center;
}
/* 编辑器容器：固定高度 + overflow hidden，内部滚动由 CodeMirror 的 .cm-scroller 负责 */
.editor-host {
  height: 62vh;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
}
/* 有标签条时收一点高度，弹窗不超出视口 */
.pane.with-tabs .editor-host {
  height: calc(62vh - 30px);
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.foot-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.hint {
  font-size: 12px;
  color: #a0acb9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.foot-right {
  flex-shrink: 0;
}
</style>
