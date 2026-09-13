// 内置常用命令库：按分类组织的 Linux 服务器常用命令，终端上方面板展示（可搜索/筛选）。
// 约定：cmd 里用 <占位符> 表示需要用户替换的部分；面板对含占位符的命令只发送不回车。
export const commandCategories = [
  {
    name: '系统',
    commands: [
      { name: '系统信息', cmd: 'uname -a' },
      { name: '发行版', cmd: 'cat /etc/os-release' },
      { name: '运行时间/负载', cmd: 'uptime' },
      { name: '内核日志', cmd: 'dmesg -T | tail -n 30' },
      { name: '当前用户', cmd: 'whoami && id' },
      { name: '在线用户', cmd: 'who' },
      { name: '主机名', cmd: 'hostnamectl' },
    ],
  },
  {
    name: 'CPU/内存',
    commands: [
      { name: '内存', cmd: 'free -h' },
      { name: 'CPU 型号', cmd: "grep 'model name' /proc/cpuinfo | uniq" },
      { name: 'CPU 核数', cmd: 'nproc' },
      { name: 'CPU 占用 TOP10', cmd: 'ps aux --sort=-%cpu | head -n 11' },
      { name: '内存占用 TOP10', cmd: 'ps aux --sort=-%mem | head -n 11' },
      { name: '实时概览', cmd: 'top -bn1 | head -n 20' },
    ],
  },
  {
    name: '磁盘',
    commands: [
      { name: '磁盘空间', cmd: 'df -h' },
      { name: '块设备', cmd: 'lsblk' },
      { name: '目录大小', cmd: 'du -sh * | sort -rh' },
      { name: 'inode', cmd: 'df -i' },
      { name: '挂载表', cmd: 'mount | column -t' },
    ],
  },
  {
    name: '网络',
    commands: [
      { name: '网卡/IP', cmd: 'ip -br addr' },
      { name: '监听端口', cmd: 'ss -tlnp' },
      { name: '连接统计', cmd: 'ss -s' },
      { name: '所有连接', cmd: 'ss -antp' },
      { name: '公网 IP', cmd: 'curl -s ifconfig.me && echo' },
      { name: '路由表', cmd: 'ip route' },
      { name: 'ping 测试', cmd: 'ping -c 4 <目标IP>' },
    ],
  },
  {
    name: '下载',
    commands: [
      { name: 'wget 下载', cmd: 'wget <URL>' },
      { name: 'wget 断点续传', cmd: 'wget -c <URL>' },
      { name: 'wget 另存为', cmd: 'wget -O <文件名> <URL>' },
      { name: 'wget 限速下载', cmd: 'wget --limit-rate=2m <URL>' },
      { name: 'wget 整站镜像', cmd: 'wget -r -np -k <URL>' },
      { name: 'curl 下载', cmd: 'curl -LO <URL>' },
      { name: 'curl 另存为', cmd: 'curl -L -o <文件名> <URL>' },
      { name: 'curl 断点续传', cmd: 'curl -L -C - -O <URL>' },
      { name: 'curl 看响应头', cmd: 'curl -sIL <URL>' },
      { name: 'curl 下载重试', cmd: 'curl -LO --retry 3 <URL>' },
    ],
  },
  {
    name: 'HTTP调试',
    commands: [
      { name: '响应头', cmd: 'curl -sI <URL>' },
      { name: '响应头+Body', cmd: 'curl -si <URL>' },
      { name: '请求+响应全过程', cmd: 'curl -v <URL>' },
      { name: '只看 Body', cmd: 'curl -s <URL>' },
      { name: 'Body 美化 JSON', cmd: 'curl -s <URL> | python3 -m json.tool' },
      { name: 'GET 带参数', cmd: "curl -s '<URL>?a=1&b=2'" },
      { name: 'POST JSON', cmd: 'curl -s -X POST -H \'Content-Type: application/json\' -d \'{"key":"value"}\' <URL>' },
      { name: 'POST 表单', cmd: "curl -s -X POST -d 'a=1&b=2' <URL>" },
      { name: '带认证头', cmd: "curl -s -H 'Authorization: Bearer <token>' <URL>" },
      { name: '各阶段耗时', cmd: "curl -s -o /dev/null -w 'DNS解析:%{time_namelookup}s 建连:%{time_connect}s 总耗时:%{time_total}s\\n' <URL>" },
    ],
  },
  {
    name: '进程/服务',
    commands: [
      { name: '进程列表', cmd: 'ps aux' },
      { name: '查进程', cmd: 'ps -ef | grep <关键词>' },
      { name: '服务状态', cmd: 'systemctl status <服务名>' },
      { name: '失败的服务', cmd: 'systemctl --failed' },
      { name: '系统日志', cmd: 'journalctl -xe --no-pager | tail -n 50' },
    ],
  },
  {
    name: '文件/搜索',
    commands: [
      { name: '详细列表', cmd: 'ls -lah' },
      { name: '找文件', cmd: 'find / -name <名称> 2>/dev/null' },
      { name: '找文本', cmd: "grep -rn '<文本>' . --exclude-dir=node_modules" },
      { name: '文件尾部', cmd: 'tail -n 100 <文件>' },
      { name: '实时日志', cmd: 'tail -f <文件>' },
      { name: '统计行数', cmd: 'wc -l <文件>' },
    ],
  },
  {
    name: '压缩/解压',
    commands: [
      { name: '打包 .tar.gz', cmd: 'tar czf <目标.tar.gz> <源目录>' },
      { name: '解压 .tar.gz', cmd: 'tar zxf <文件.tar.gz>' },
      { name: '解压 .zip', cmd: 'unzip <文件.zip>' },
    ],
  },
  {
    name: '容器',
    commands: [
      { name: '容器列表', cmd: 'docker ps -a' },
      { name: '容器资源', cmd: 'docker stats --no-stream' },
      { name: '容器日志', cmd: 'docker logs -f --tail 100 <容器>' },
      { name: '镜像列表', cmd: 'docker images' },
      { name: 'Docker 占用', cmd: 'docker system df' },
    ],
  },
]
