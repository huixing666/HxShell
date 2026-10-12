import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildCopyCommand, pathsForCopy } from '../src/copyCommand.js'

const src = { username: 'root', host: '10.0.0.8', port: 22 }

test('single file is an rsync pull into the destination cwd', () => {
  assert.equal(
    buildCopyCommand(['/var/log/a.log'], src),
    "rsync -avPs -e 'ssh -p 22' -- 'root@10.0.0.8:/var/log/a.log' ."
  )
})

test('directory and file keep list order and repeat the server', () => {
  assert.equal(
    buildCopyCommand(['/data/conf', '/data/app.log'], { username: 'deploy', host: 'app.example.com', port: 2222 }),
    "rsync -avPs -e 'ssh -p 2222' -- 'deploy@app.example.com:/data/conf' 'deploy@app.example.com:/data/app.log' ."
  )
})

test('spaces, expansions and quotes stay literal', () => {
  assert.equal(
    buildCopyCommand(['/tmp/my file', '/tmp/$(rm -rf /)', "/tmp/it's", '/tmp/`id`'], src),
    "rsync -avPs -e 'ssh -p 22' -- 'root@10.0.0.8:/tmp/my file' 'root@10.0.0.8:/tmp/$(rm -rf /)' 'root@10.0.0.8:/tmp/it'\\''s' 'root@10.0.0.8:/tmp/`id`' ."
  )
})

test('leading-dash name is behind -- and still quoted', () => {
  assert.equal(
    buildCopyCommand(['/tmp/-rf'], src),
    "rsync -avPs -e 'ssh -p 22' -- 'root@10.0.0.8:/tmp/-rf' ."
  )
})

test('ipv6 host is bracketed so the path colon stays intact', () => {
  assert.equal(
    buildCopyCommand(['/etc/hosts'], { username: 'root', host: '2001:db8::1', port: 22 }),
    "rsync -avPs -e 'ssh -p 22' -- 'root@[2001:db8::1]:/etc/hosts' ."
  )
})

test('already bracketed host is not wrapped twice', () => {
  assert.equal(
    buildCopyCommand(['/etc/hosts'], { username: 'root', host: '[2001:db8::1]', port: 22 }),
    "rsync -avPs -e 'ssh -p 22' -- 'root@[2001:db8::1]:/etc/hosts' ."
  )
})

test('string port is accepted; missing or invalid port falls back to 22', () => {
  assert.equal(
    buildCopyCommand(['/ok'], { username: 'u', host: 'h', port: '2200' }),
    "rsync -avPs -e 'ssh -p 2200' -- 'u@h:/ok' ."
  )
  assert.equal(
    buildCopyCommand(['/ok'], { username: 'u', host: 'h' }),
    "rsync -avPs -e 'ssh -p 22' -- 'u@h:/ok' ."
  )
  assert.equal(
    buildCopyCommand(['/ok'], { username: 'u', host: 'h', port: 'nope' }),
    "rsync -avPs -e 'ssh -p 22' -- 'u@h:/ok' ."
  )
})

test('hostile host or user stays inside quotes', () => {
  assert.equal(
    buildCopyCommand(['/ok'], { username: "ro'ot", host: "h';id", port: 22 }),
    "rsync -avPs -e 'ssh -p 22' -- 'ro'\\''ot@h'\\'';id:/ok' ."
  )
})

test('blank paths are dropped; nothing selected or no server yields no command', () => {
  assert.equal(buildCopyCommand([], src), '')
  assert.equal(buildCopyCommand([null, '  ', ''], src), '')
  assert.equal(buildCopyCommand(['/ok'], { username: '  ', host: 'h', port: 22 }), '')
  assert.equal(buildCopyCommand(['/ok'], { username: 'u', host: '', port: 22 }), '')
  assert.equal(buildCopyCommand(['/ok']), '')
  assert.equal(
    buildCopyCommand(['  ', '/ok'], src),
    "rsync -avPs -e 'ssh -p 22' -- 'root@10.0.0.8:/ok' ."
  )
})

test('significant spaces in a path are preserved', () => {
  assert.equal(
    buildCopyCommand(['/tmp/a '], src),
    "rsync -avPs -e 'ssh -p 22' -- 'root@10.0.0.8:/tmp/a ' ."
  )
})

test('right-click on a member of a multi-selection copies all', () => {
  assert.deepEqual(pathsForCopy(['/a', '/b', '/c'], '/b'), ['/a', '/b', '/c'])
})

test('right-click outside the selection copies only that row', () => {
  assert.deepEqual(pathsForCopy(['/a', '/b'], '/c'), ['/c'])
})

test('a lone selected row copies that row', () => {
  assert.deepEqual(pathsForCopy(['/a'], '/a'), ['/a'])
})

test('toolbar action with no row uses the whole selection', () => {
  assert.deepEqual(pathsForCopy(['/a', '/b'], null), ['/a', '/b'])
  assert.deepEqual(pathsForCopy([], null), [])
})

test('file manager wires rsync to the current connection', () => {
  const fm = readFileSync(new URL('../src/components/FileManager.vue', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(fm, /command="copy-cmd"/)
  assert.match(fm, /menuCopyCommand/)
  assert.match(fm, /buildCopyCommand/)
  assert.match(fm, /pathsForCopy/)
  assert.match(fm, /copyCmdVisible/)
  assert.match(fm, /props\.username/)
  assert.match(fm, /props\.host/)
  assert.match(fm, /props\.port/)
  assert.match(app, /:host="c\.host"/)
  assert.match(app, /:port="c\.port"/)
  assert.match(app, /:username="c\.username"/)
})
