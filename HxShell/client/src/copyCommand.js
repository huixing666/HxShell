// 跨服务器拉取：在目标机器的终端粘贴执行，从当前连接把选中路径 rsync 到该终端的当前目录。
// -a 归档（目录递归，保留权限、时间、符号链接），-vP 显示进度；
// -s 让空格、$、引号不被远端 shell 拆开或展开；-e 带上这条连接的 SSH 端口。
// 不写密码：对面按 ssh 正常确认主机密钥、询问密码或走已配置的密钥。
// 整段 user@host:path 用单引号，避免本地 shell 展开。

export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function sshPort(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 22
  return n
}

// rsync 把第一个冒号当「主机:路径」分隔。IPv6 必须写成 [addr]，否则冒号会被拆错。
function rsyncHost(host) {
  if (host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))) return `[${host}]`
  return host
}

export function buildCopyCommand(paths, server) {
  const list = []
  for (const p of paths || []) {
    if (p == null) continue
    const s = String(p)
    if (s.trim() === '') continue
    list.push(s)
  }
  if (!list.length) return ''
  const user = String(server?.username ?? '').trim()
  const host = String(server?.host ?? '').trim()
  if (!user || !host) return ''
  const port = sshPort(server?.port)
  const ssh = shellSingleQuote(`ssh -p ${port}`)
  const specs = list.map((p) => shellSingleQuote(`${user}@${rsyncHost(host)}:${p}`))
  return `rsync -avPs -e ${ssh} -- ${specs.join(' ')} .`
}

// 右键落在多选中的一项：命令覆盖整个选中集（与下载/删除一致）。
// 否则只针对右键的那一行。没有行（操作菜单）时用整个选中集。
export function pathsForCopy(selectedPaths, rowPath) {
  const selected = []
  for (const p of selectedPaths || []) {
    if (p == null) continue
    const s = String(p)
    if (s.trim() === '') continue
    selected.push(s)
  }
  if (rowPath != null && String(rowPath).trim() !== '') {
    const row = String(rowPath)
    if (selected.length > 1 && selected.includes(row)) return selected
    return [row]
  }
  return selected
}
