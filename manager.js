#!/usr/bin/env node
/**
 * MacTools 统一控制台
 *
 * 自身只是一个常驻的管理面板：默认**不启动任何子服务**，
 * 用户在网页上点哪个，才拉起哪个；再点停止就关掉。
 * 也支持通过 Manager 的 /proxy/<id>/... 反向代理访问子服务（对外只暴露一个端口）。
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'services.json'), 'utf8'));
const BIN = path.join(ROOT, 'bin');

/** id -> { proc, pid, logs:[], startedAt, external:bool } */
const STATE = new Map();

// ------------------------------------------------------------------ 工具函数

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function svcById(id) {
  return CONFIG.services.find((s) => s.id === id);
}

function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: CONFIG.host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeout, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(false));
  });
}

/** 谁占着这个端口？返回 PID 数组 */
function pidsOnPort(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);
      resolve([...new Set(stdout.trim().split(/\s+/).filter(Boolean))].map(Number));
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pushLog(id, text) {
  const st = STATE.get(id);
  if (!st) return;
  const lines = text.split('\n').filter((l) => l.trim());
  st.logs.push(...lines.map((l) => `[${new Date().toLocaleTimeString('zh-CN')}] ${l}`));
  if (st.logs.length > 200) st.logs.splice(0, st.logs.length - 200);
}

// ------------------------------------------------------------------ 生命周期

async function startService(id) {
  const svc = svcById(id);
  if (!svc) return { ok: false, error: '未知服务' };

  // 已在跑（本 Manager 拉的）
  const cur = STATE.get(id);
  if (cur && cur.pid && alive(cur.pid)) return { ok: true, already: true };

  // 端口被别的进程占着 → 接管它，不再重复起
  if (await portOpen(svc.port)) {
    const pids = await pidsOnPort(svc.port);
    STATE.set(id, { proc: null, pid: pids[0] || null, external: true, logs: [], startedAt: null });
    return { ok: true, already: true, adopted: pids[0] || null };
  }

  const st = { proc: null, pid: null, external: false, logs: [], startedAt: Date.now() };
  STATE.set(id, st);

  const args = svc.args.map((a) => String(a).replace('{port}', svc.port));
  const proc = spawn(CONFIG.python, [path.join(BIN, svc.script), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  st.proc = proc;
  st.pid = proc.pid;
  proc.stdout.on('data', (d) => pushLog(id, d.toString()));
  proc.stderr.on('data', (d) => pushLog(id, d.toString()));
  proc.on('exit', (code) => {
    pushLog(id, `进程退出，code=${code}`);
    if (STATE.get(id) === st) st.proc = null;
  });

  // 等服务真的listen起来
  for (let i = 0; i < 40; i++) {
    if (await portOpen(svc.port)) return { ok: true, pid: proc.pid };
    await sleep(250);
  }
  return { ok: false, error: '启动超时，见日志', log: st.logs.slice(-10) };
}

async function stopService(id) {
  const svc = svcById(id);
  if (!svc) return { ok: false, error: '未知服务' };
  const st = STATE.get(id);
  let killed = [];

  if (st) {
    if (st.proc && st.proc.exitCode === null) {
      st.proc.kill('SIGINT');
      killed.push(st.pid);
      await sleep(600);
      if (alive(st.pid)) st.proc.kill('SIGKILL');
    } else if (st.pid && alive(st.pid)) {
      process.kill(st.pid, 'SIGTERM');
      killed.push(st.pid);
    }
  }
  // 端口上还有残留（外部起的）一并处理
  for (const pid of await pidsOnPort(svc.port)) {
    if (!killed.includes(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch {}
    }
  }
  await sleep(400);
  STATE.set(id, { proc: null, pid: null, external: false, logs: st ? st.logs : [], startedAt: null });
  return { ok: true, killed, settled: !(await portOpen(svc.port)) };
}

async function snapshot() {
  const out = [];
  for (const svc of CONFIG.services) {
    const st = STATE.get(svc.id) || {};
    const listening = await portOpen(svc.port);
    const own = st.pid && alive(st.pid);
    out.push({
      id: svc.id,
      name: svc.name,
      desc: svc.desc,
      icon: svc.icon,
      port: svc.port,
      note: svc.note,
      running: listening,
      status: listening ? (st.external ? 'external' : 'managed') : 'stopped',
      pid: own ? st.pid : st.external && st.pid ? st.pid : null,
      since: st.startedAt,
      url: `http://${CONFIG.host}:${svc.port}/`,
    });
  }
  return out;
}

// -------------------------------------------------------------- 反向代理
// 子服务页面里的资源都是绝对路径(/api/...)，直接嵌套 iframe 最省事；
// proxy 只用于 API 转发，方便单点访问。

function proxy(targetPort, req, res) {
  const proxyReq = http.request(
    { host: CONFIG.host, port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `${CONFIG.host}:${targetPort}` } },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    }
  );
  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'proxy_failed', detail: e.message }));
  });
  req.pipe(proxyReq);
}

// ------------------------------------------------------------------ HTTP

function json(res, code, data) {
  const body = JSON.stringify(data, null, 0);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${CONFIG.host}:${CONFIG.managerPort}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT, 'lib', 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/api/services') return json(res, 200, { services: await snapshot(), managerPort: CONFIG.managerPort });

    let m = url.pathname.match(/^\/api\/services\/([\w-]+)\/start$/);
    if (m && req.method === 'POST') return json(res, 200, await startService(m[1]));

    m = url.pathname.match(/^\/api\/services\/([\w-]+)\/stop$/);
    if (m && req.method === 'POST') return json(res, 200, await stopService(m[1]));

    m = url.pathname.match(/^\/api\/services\/([\w-]+)\/log$/);
    if (m) {
      const st = STATE.get(m[1]) || { logs: [] };
      return json(res, 200, { log: st.logs.slice(-80) });
    }

    m = url.pathname.match(/^\/proxy\/([\w-]+)(\/.*)?$/);
    if (m) {
      const svc = svcById(m[1]);
      if (!svc) return json(res, 404, { error: 'unknown service' });
      if (!(await portOpen(svc.port))) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8"><body style="font-family:-apple-system;background:#0d1117;color:#e6edf3;padding:40px">服务未运行，回到控制台点击「启动」。</body>');
      }
      return proxy(svc.port, { ...req, url: m[2] || '/' }, res);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// ------------------------------------------------------------------- 面板页

function boot() {
  server.listen(CONFIG.managerPort, CONFIG.host, () => {
    const url = `http://${CONFIG.host}:${CONFIG.managerPort}/`;
    console.log(`\n  MacTools 控制台已就绪: ${url}`);
    console.log('  默认不启动任何子服务 —— 在页面上点「启动」才会拉起对应进程。Ctrl-C 退出。\n');
    if (!process.argv.includes('--no-open')) {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  });
}

process.on('SIGINT', () => {
  console.log('\n控制台已退出（子进程保留在后台运行）');
  process.exit(0);
});

if (require.main === module) boot();
module.exports = { startService, stopService, snapshot };
