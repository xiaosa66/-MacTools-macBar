"""brightsync 核心：显示器亮度读写、配置、映射关系。

被 bin/brightsync（CLI）和 bin/brightsync-web（控制面板）共用。

亮度读写走 macOS 原生通道 DisplayServices —— 就是系统设置「显示器」里那根
亮度条背后的接口，内建屏和外接屏同一套 API，读写都是真背光（不是软件调光）。
"""

import ctypes
import json
import os
import subprocess
from ctypes import POINTER, byref, c_float, c_uint32

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "lib", "brightsync.json")
PID_PATH = os.path.expanduser("~/Library/Application Support/MacTools/brightsync.pid")
LOG_PATH = os.path.expanduser("~/Library/Logs/brightsync.log")

DEFAULT_CONFIG = {
    "enabled": True,
    "anchors": [[0, 0], [25, 18], [50, 40], [75, 68], [100, 100]],
    "clamp": [0, 100],
    "deadband": 2.0,
    "minStep": 1.0,
    "interval": 0.5,
}

# ---------------------------------------------------------------- 原生接口

_CG = ctypes.cdll.LoadLibrary(
    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
_DS = ctypes.cdll.LoadLibrary(
    "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices")

_CG.CGGetActiveDisplayList.argtypes = [c_uint32, POINTER(c_uint32), POINTER(c_uint32)]
_CG.CGGetActiveDisplayList.restype = ctypes.c_int
_CG.CGDisplayIsBuiltin.argtypes = [c_uint32]
_CG.CGDisplayIsBuiltin.restype = ctypes.c_bool

_DS.DisplayServicesGetBrightness.argtypes = [c_uint32, POINTER(c_float)]
_DS.DisplayServicesGetBrightness.restype = ctypes.c_int
_DS.DisplayServicesSetBrightness.argtypes = [c_uint32, c_float]
_DS.DisplayServicesSetBrightness.restype = ctypes.c_int


def active_displays():
    ids = (c_uint32 * 16)()
    n = c_uint32(0)
    if _CG.CGGetActiveDisplayList(16, ids, byref(n)) != 0:
        return []
    return list(ids)[:n.value]


def builtin_id():
    for d in active_displays():
        if _CG.CGDisplayIsBuiltin(d):
            return d
    return None


def external_ids():
    return [d for d in active_displays() if not _CG.CGDisplayIsBuiltin(d)]


def get_brightness(display_id):
    """读亮度，返回 0..100 的百分数；读不到返回 None。"""
    if display_id is None:
        return None
    val = c_float(0.0)
    if _DS.DisplayServicesGetBrightness(display_id, byref(val)) != 0:
        return None
    return max(0.0, min(100.0, val.value * 100.0))


def set_brightness(display_id, pct):
    """写亮度，pct 为 0..100。成功返回 True。"""
    if display_id is None:
        return False
    pct = max(0.0, min(100.0, float(pct)))
    return _DS.DisplayServicesSetBrightness(display_id, pct / 100.0) == 0


# ---------------------------------------------------------------- 配置

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
        cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        pass
    cfg["anchors"] = sorted((float(a[0]), float(a[1])) for a in cfg["anchors"])
    return cfg


def save_config(cfg):
    """原子写：先写临时文件再 replace，避免 watch 读到半截 JSON。

    手写序列化而不是 json.dump(indent=2)：后者会把每个锚点摊成多行（33 行的文件），
    这份配置是要人肉读改的，锚点保持一行一对更好看。
    """
    pts = ", ".join("[%s, %s]" % (_num(a), _num(b)) for a, b in cfg["anchors"])
    lo, hi = cfg["clamp"]
    text = (
        "{\n"
        '  "_comment": "brightsync 映射配置。anchors 为 [[内建%%, 外接%%], ...]，分段线性插值，改完 watch 自动重载。",\n'
        '  "enabled": %s,\n'
        '  "anchors": [%s],\n'
        '  "clamp": [%s, %s],\n'
        '  "deadband": %s,\n'
        '  "minStep": %s,\n'
        '  "interval": %s\n'
        "}\n"
    ) % ("true" if cfg.get("enabled", True) else "false",
         pts, _num(lo), _num(hi),
         _num(cfg["deadband"]), _num(cfg["minStep"]), _num(cfg["interval"]))

    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, CONFIG_PATH)
    return load_config()


def _num(v):
    """整数就不带小数点，避免 0.0 / 100.0 这种噪音。"""
    f = float(v)
    return str(int(f)) if f == int(f) else ("%g" % f)


# ---------------------------------------------------------------- 映射关系

def map_brightness(internal, cfg):
    """内建亮度(%) -> 外接亮度(%)。

    默认实现：按 cfg["anchors"] 分段线性插值，锚点外做端点钳制。

    【扩展点】要换成任意曲线（gamma、对数、按时间段分段、学习模型……），
    直接替换本函数体即可，调用方只认「进一个百分数、出一个百分数」。
    """
    pts = cfg["anchors"]
    if not pts:
        return internal

    x = max(0.0, min(100.0, float(internal)))
    lo, hi = cfg["clamp"]

    if x <= pts[0][0]:
        y = pts[0][1]
    elif x >= pts[-1][0]:
        y = pts[-1][1]
    else:
        y = pts[-1][1]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if x0 <= x <= x1:
                span = x1 - x0
                y = y0 if span <= 0 else y0 + (y1 - y0) * (x - x0) / span
                break

    return max(lo, min(hi, y))


# ---------------------------------------------------------------- 进程登记

def watch_pid():
    """跟随进程的 pid；没在跑返回 None。"""
    try:
        with open(PID_PATH, "r", encoding="utf-8") as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return None
    if _alive(pid):
        return pid
    # pidfile 残留（进程异常退出）→ 清掉
    unregister_watch()
    return None


def _alive(pid):
    """进程还活着吗。

    坑：已被 kill 但父进程还没回收的子进程是僵尸，kill(pid, 0) 对它仍成功。
    所以先试 waitpid —— 只对「自己的子进程」有效，能顺带把僵尸回收掉；
    不是自己的子进程会抛 ChildProcessError，再退回 kill(pid, 0) 判断。
    不依赖 ps 命令（受限环境里可能被禁）。
    """
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)
        if reaped == pid:
            return False
        return True
    except ChildProcessError:
        pass
    except OSError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def register_watch():
    os.makedirs(os.path.dirname(PID_PATH), exist_ok=True)
    with open(PID_PATH, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))


def unregister_watch():
    try:
        os.remove(PID_PATH)
    except OSError:
        pass


# ---------------------------------------------------------------- 动作

def state(cfg=None):
    """当前状态快照，供 CLI 与 Web 共用。"""
    cfg = cfg or load_config()
    b = builtin_id()
    internal = get_brightness(b)
    target = map_brightness(internal, cfg) if internal is not None else None

    ext = []
    for d in external_ids():
        cur = get_brightness(d)
        ext.append({
            "id": d,
            "current": None if cur is None else round(cur, 1),
            "mapped": None if target is None else round(target, 1),
            "delta": None if (cur is None or target is None) else round(cur - target, 1),
        })

    pid = watch_pid()
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "watching": pid is not None,
        "pid": pid,
        "builtin": {"id": b, "brightness": None if internal is None else round(internal, 1)},
        "external": ext,
        "config": {
            "anchors": [[a, b] for a, b in cfg["anchors"]],
            "clamp": list(cfg["clamp"]),
            "deadband": cfg["deadband"],
            "minStep": cfg["minStep"],
            "interval": cfg["interval"],
        },
    }


def sync_once(cfg=None, dry=False):
    """按当前内建亮度同步一次外接屏。返回 (ok, internal, target, results)。"""
    cfg = cfg or load_config()
    internal = get_brightness(builtin_id())
    if internal is None:
        return False, None, None, []
    target = map_brightness(internal, cfg)
    results = []
    for d in external_ids():
        ok = True if dry else set_brightness(d, target)
        results.append({"id": d, "ok": ok, "target": round(target, 1)})
    return all(r["ok"] for r in results) and bool(results), internal, target, results
