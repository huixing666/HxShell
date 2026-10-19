import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// 直接抽取 Terminal.vue 里的真实实现来测，避免测试和源码各写一份逻辑。
const source = readFileSync(new URL('../src/components/Terminal.vue', import.meta.url), 'utf8')

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `源码里找不到 ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.ok(end > start, `源码里找不到 ${endMarker}`)
  return source.slice(start, end)
}

const normalizeSrc = slice('function normalizePasteText', '// 把整段文本一次性送进终端')
const sendPasteSrc = slice('function sendPaste', '// 处理待粘贴内容')

// 用假 xterm / sendInput 构造运行环境，拿到真实函数
function load({ bracketedPasteMode }) {
  const sent = []
  const factory = new Function('xterm', 'sendInput',
    normalizeSrc + '\n' + sendPasteSrc + '\nreturn { normalizePasteText, sendPaste }')
  const mod = factory({ modes: { bracketedPasteMode } }, (data) => sent.push(data))
  return { ...mod, sent }
}

const IPTABLES = [
  'iptables -t nat -A POSTROUTING \\',
  '-d 185.42.223.38 \\',
  '-p tcp --dport 3389 \\',
  '-j SNAT --to-source 172.17.0.1',
].join('\n')

test('续行反斜杠 + LF 原样保留', () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  assert.equal(normalizePasteText(IPTABLES), IPTABLES)
})

test('CRLF 归一为 LF，续行不被破坏', () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  const crlf = IPTABLES.replace(/\n/g, '\r\n')
  assert.equal(normalizePasteText(crlf), IPTABLES)
})

test('反斜杠后的空白原样保留，不能猜测引号和 here-document 语义', () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  for (const whitespace of [' ', '\t', '\u00a0', '\u3000', '\u200b']) {
    const quoted = "printf '%s' 'a" + String.fromCharCode(92) + whitespace + "\nb'"
    assert.equal(normalizePasteText(quoted), quoted)
    const heredoc = "cat <<'EOF'\na" + String.fromCharCode(92) + whitespace + "\nb\nEOF"
    assert.equal(normalizePasteText(heredoc), heredoc)
  }
})

test('转义空格本身不误删：引号内/行中空白保持原样', () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  assert.equal(normalizePasteText('echo "a  b"'), 'echo "a  b"')
  assert.equal(normalizePasteText('printf "%s" a\\ b'), 'printf "%s" a\\ b')
})

test('双反斜杠结尾不被当成续行清理', () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  assert.equal(normalizePasteText('echo a \\\\\nb'), 'echo a \\\\\nb')
})

test('末尾换行被去掉，单行文本不受影响', () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  assert.equal(normalizePasteText('ls -la\n'), 'ls -la')
  assert.equal(normalizePasteText('ls -la\r\n\r\n'), 'ls -la')
  assert.equal(normalizePasteText('ls -la'), 'ls -la')
})

test('远端开启括号粘贴：多行整体包裹，只有一个回车提交', () => {
  const { sendPaste, sent } = load({ bracketedPasteMode: true })
  sendPaste(IPTABLES + '\n', true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0], '\x1b[200~' + IPTABLES + '\x1b[201~\r')
  // 中间没有任何回车，shell 不会逐行执行
  assert.equal(sent[0].slice(6, -6).includes('\r'), false)
})

test('远端开启括号粘贴：仅粘贴不补回车', () => {
  const { sendPaste, sent } = load({ bracketedPasteMode: true })
  sendPaste(IPTABLES, false)
  assert.equal(sent[0], '\x1b[200~' + IPTABLES + '\x1b[201~')
})

test('远端未开启括号粘贴：原样整段发送并补一个回车', () => {
  const { sendPaste, sent } = load({ bracketedPasteMode: false })
  sendPaste(IPTABLES, true)
  assert.equal(sent[0], IPTABLES + '\r')
})

test('单行粘贴也保留远端括号粘贴保护', () => {
  const { sendPaste, sent } = load({ bracketedPasteMode: true })
  sendPaste('ls -la', true)
  assert.equal(sent[0], '\x1b[200~ls -la\x1b[201~\r')
})

test('空内容不发任何数据', () => {
  const { sendPaste, sent } = load({ bracketedPasteMode: true })
  sendPaste('', true)
  sendPaste('\n\n', true)
  assert.equal(sent.length, 0)
})

function pasteHandlers(bracketedPasteMode = true) {
  const sent = []
  const pasteDraft = { value: '' }
  const pasteDraftVisible = { value: false }
  const factory = new Function('xterm', 'sendInput', 'pasteDraft', 'pasteDraftVisible',
    normalizeSrc + '\n' + sendPasteSrc + '\n'
    + slice('function handlePasteText', '// 读取剪贴板并发送') + '\n'
    + slice('function doPasteExecute', '// ---- 浏览器保留快捷键')
    + '\nreturn { onTermPaste, doPasteExecute, doPastePlain }')
  const mod = factory({ modes: { bracketedPasteMode }, focus() {} }, (data) => sent.push(data), pasteDraft, pasteDraftVisible)
  return { ...mod, sent, pasteDraftVisible }
}

test('原生粘贴进入统一入口，单行 Tab 保持字面内容', () => {
  const h = pasteHandlers()
  let stopped = 0
  h.onTermPaste({ clipboardData: { getData: () => 'printf abc\tZ' },
    preventDefault() { stopped++ }, stopPropagation() { stopped++ } })
  assert.equal(stopped, 2)
  assert.deepEqual(h.sent, ['\x1b[200~printf abc\tZ\x1b[201~'])
})

test('末尾带换行的原生粘贴先确认，再按执行或仅粘贴发送', () => {
  for (const execute of [true, false]) {
    const h = pasteHandlers()
    h.onTermPaste({ clipboardData: { getData: () => IPTABLES + '\r\n' },
      preventDefault() {}, stopPropagation() {} })
    assert.equal(h.pasteDraftVisible.value, true)
    assert.deepEqual(h.sent, [])
    if (execute) h.doPasteExecute()
    else h.doPastePlain()
    assert.deepEqual(h.sent, ['\x1b[200~' + IPTABLES + '\x1b[201~' + (execute ? '\r' : '')])
    assert.equal(h.pasteDraftVisible.value, false)
  }
})

test('剪贴板没有文本时保留原生处理', () => {
  const h = pasteHandlers()
  h.onTermPaste({ clipboardData: { getData: () => '' },
    preventDefault() { assert.fail('不能拦截空文本') }, stopPropagation() { assert.fail('不能阻止原生处理') } })
  assert.deepEqual(h.sent, [])
})

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
test('Bash 实际解析 CRLF 粘贴后，只调用一次 iptables 并收到全部参数', { skip: !existsSync(bash) }, () => {
  const { normalizePasteText } = load({ bracketedPasteMode: false })
  // 用函数替代 iptables，只打印参数，绝不修改机器网络规则。
  const script = "iptables() { printf 'CALL\\n'; printf '<%s>\\n' \"$@\"; }\n"
    + normalizePasteText(IPTABLES.replace(/\n/g, '\r\n')) + '\n'
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'CALL\n' + ['-t', 'nat', '-A', 'POSTROUTING', '-d', '185.42.223.38', '-p', 'tcp', '--dport', '3389', '-j', 'SNAT', '--to-source', '172.17.0.1'].map(x => '<' + x + '>\n').join(''))
})
