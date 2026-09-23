#!/bin/sh
# 推送到 GitHub（新仓库）
#
#   用法: sh tools/push-to-github.sh [仓库名] [--public]
#   默认: 私有仓库 MacTools-v2
#
#   前提：网络可达 github.com，且 gh 已登录。
#   gh 未登录：  gh auth login -h github.com -p ssh -w
#   token 失效：gh auth refresh -h github.com
#   不开浏览器：gh auth login --with-token < token.txt
set -e

REPO="${1:-MacTools-v2}"
VIS="--private"
[ "$2" = "--public" ] && VIS="--public"

GH="${GH_BIN:-$(command -v gh || echo /Users/wuzhengliu/.local/bin/gh)}"
cd "$(dirname "$0")/.."

echo "== gh 版本 =="
"$GH" --version | head -1

echo
echo "== 登录状态 =="
if ! "$GH" auth status 2>&1 | grep -q "Logged in"; then
  echo "未登录 / token 失效，先执行："
  echo "    $GH auth login -h github.com -p ssh -w"
  exit 1
fi

echo
echo "== 创建并推送 $REPO ($VIS) =="
"$GH" repo create "$REPO" "$VIS" --source . --remote origin --push

echo
"$GH" repo view "$REPO" --web 2>/dev/null || echo "https://github.com/xiaosa66/$REPO"
