#!/usr/bin/env node
/**
 * MacTools 菜单栏 App 构建脚本
 *
 *   node bin/build-menubar.js           编译 -> 打包 MacToolsMenu.app -> ad-hoc 签名
 *   node bin/build-menubar.js --agent   再加：生成 LaunchAgent 并装载（开机自启）
 *   node bin/build-menubar.js --unagent 卸载 LaunchAgent
 *   node bin/build-menubar.js --restart 重新编译并重启 App
 *   node bin/build-menubar.js --status  查看 App / LaunchAgent 状态
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'MacToolsMenu.swift');
const APP_DIR = path.join(ROOT, 'MacToolsMenu.app');
const MACOS = path.join(APP_DIR, 'Contents', 'MacOS');
const RES = path.join(APP_DIR, 'Contents', 'Resources');
const BIN_NAME = 'MacToolsMenu';
const LABEL = 'dev.mactools.menubar';
const AGENT_PATH = path.join(process.env.HOME, 'Library/LaunchAgents', `${LABEL}.plist`);

// 坑：本机 swiftc 的默认 target 是 macosx28.0（比宿主 macOS 27.0 高一档），
// 编出来的二进制 minos=28，双击直接报"不能与此版本的 macOS 配合使用"。
// 必须显式钉住 deployment target。15.0 兼顾向下兼容。
const TARGET = 'arm64-apple-macos15.0';
const MIN_SYSTEM = '15.0';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MacToolsMenu</string>
  <key>CFBundleDisplayName</key><string>MacTools</string>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${BIN_NAME}</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_SYSTEM}</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
</dict>
</plist>
`;

const AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${path.join(MACOS, BIN_NAME)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : ['ignore', 'pipe', 'pipe'], ...opts });
}

function build({ verbose = false } = {}) {
  if (!fs.existsSync(SRC)) throw new Error(`缺少源码: ${SRC}`);
  for (const d of [MACOS, RES]) fs.mkdirSync(d, { recursive: true });

  const out = path.join(MACOS, BIN_NAME);
  console.log(`编译 Swift… target=${TARGET}`);
  sh(`swiftc -O -target ${TARGET} "${SRC}" -o "${out}"`, { silent: true });

  // 校验：minos 不能高于宿主系统版本，否则双击会报"不能与此版本的 macOS 配合使用"
  let minos = null;
  try {
    const ld = sh(`otool -l "${out}"`, { silent: true });
    const m = ld.split(/\n/).find((l) => l.includes('minos'))?.match(/minos ([\d.]+)/);
    minos = m ? m[1] : null;
  } catch {
    /* ignore */
  }
  const sysMajor = Number(sh('sw_vers -productVersion').trim().split('.')[0]);
  if (minos && Number(String(minos).split('.')[0]) > sysMajor) {
    throw new Error(`产物 minos=${minos} 高于系统 ${sysMajor}.0，请调低 TARGET`);
  }
  console.log(`  minos=${minos}  系统=${sysMajor}.0  ✓`);

  fs.writeFileSync(path.join(APP_DIR, 'Contents/Info.plist'), PLIST);
  try {
    execFileSync('codesign', ['-s', '-', '-f', APP_DIR], { stdio: 'ignore' });
  } catch {
    /* ad-hoc 签名失败不影响本地运行 */
  }

  const size = sh(`du -sh "${APP_DIR}"`).split('\t')[0].trim();
  console.log(`完成: ${APP_DIR}  (${size})`);
  return APP_DIR;
}

function agentInstall() {
  if (!fs.existsSync(path.join(MACOS, BIN_NAME))) build();
  fs.writeFileSync(AGENT_PATH, AGENT_PLIST);
  const uid = Number(sh('id -u').trim());
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    /* 之前没装载过 */
  }
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, AGENT_PATH], { stdio: 'inherit' });
  console.log(`已装载开机自启: ${AGENT_PATH}`);
  console.log('菜单栏图标应已出现（右上角）');
}

function agentRemove() {
  const uid = Number(sh('id -u').trim());
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    fs.writeFileSync(
      AGENT_PATH,
      AGENT_PLIST.replace('<key>RunAtLoad</key><true/>', '<key>RunAtLoad</key><false/>')
    );
  } catch {
    /* ignore */
  }
  console.log(`已卸载 LaunchAgent: ${LABEL}（plist 保留，RunAtLoad 置 false）`);
}

function restart() {
  try {
    execFileSync('pkill', ['-f', `${MACOS}/${BIN_NAME}`], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  build();
  execFileSync('open', [APP_DIR], { stdio: 'inherit' });
  console.log('已重启菜单栏 App');
}

function status() {
  const exists = fs.existsSync(path.join(MACOS, BIN_NAME));
  console.log(`App         : ${exists ? APP_DIR : '未构建'}`);
  let running = '';
  try {
    running = sh('pgrep -fl MacToolsMenu').trim() || '未运行';
  } catch {
    running = '未运行';
  }
  console.log(`进程        : ${running}`);
  console.log(`LaunchAgent : ${fs.existsSync(AGENT_PATH) ? AGENT_PATH : '未安装'}`);
}

const arg = process.argv[2];
if (arg === '--agent') agentInstall();
else if (arg === '--unagent') agentRemove();
else if (arg === '--restart') restart();
else if (arg === '--status') status();
else build();
