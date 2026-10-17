#!/bin/bash
# 一键部署 Horizon（VPS 端）— v2（2026-10-17）
# 触发方式（任选其一，不需要面板 Console）：
#   A) 什么都不用做：wxbot 开机自动跑本脚本（最多 3 次，见 index.js AUTO_SETUP）
#   B) 微信发「日报」或「部署日报」→ wxbot 按需跑本脚本，装好自动微信通知
#   C) 面板 Console 手动：bash /home/container/horizon-setup.sh
# 安全原则：仓库零密钥；.env 的 key 只从 600 权限的 /home/container/.secrets 读取
set -e
cd /home/container
REPO="wolaiguge00008-boop/horizon-wxbot"
echo "[setup] $(date -u +%FT%TZ) 开始"

# 1) uv（没有就装到 ~/.local/bin）
if [ ! -x "$HOME/.local/bin/uv" ]; then
  if command -v curl >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then wget -qO- https://astral.sh/uv/install.sh | sh
  else echo "[setup] 容器里 curl/wget 都没有，无法装 uv"; exit 1; fi
fi
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || { echo "[setup] uv 安装失败（网络或权限）"; exit 1; }
echo "[setup] uv = $UV"

# 2) 代码：git → curl tarball → wget tarball → busybox 三级回退（零密钥公开仓库）
fetch_repo() {
  rm -rf horizon && mkdir -p horizon
  local URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  if command -v git >/dev/null 2>&1; then
    if git clone --depth 1 "https://github.com/$REPO" horizon >/dev/null 2>&1 && [ -f horizon/src/main.py ]; then return 0; fi
    rm -rf horizon && mkdir -p horizon
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL "$URL" | tar xz --strip-components=1 -C horizon && [ -f horizon/src/main.py ]; then return 0; fi
  fi
  if command -v wget >/dev/null 2>&1; then
    if wget -qO- "$URL" | tar xz --strip-components=1 -C horizon && [ -f horizon/src/main.py ]; then return 0; fi
  fi
  if command -v busybox >/dev/null 2>&1; then
    if busybox wget -qO- "$URL" | busybox tar xz --strip-components=1 -C horizon && [ -f horizon/src/main.py ]; then return 0; fi
  fi
  return 1
}
if [ ! -f horizon/data/config.wxbot.json ]; then
  fetch_repo || { echo "[setup] 拉代码失败：git/curl/wget 都不可用，或仓库还是空的（先推 GitHub）"; exit 1; }
fi
cd horizon
[ -f src/main.py ] || { echo "[setup] 代码不完整：src/main.py 缺失"; exit 1; }
echo "[setup] 代码就绪 $(pwd)"

# 3) .env：key 只从 600 权限 .secrets 取，绝不进仓库/git/日志
KEY="$(grep '^AGNES_API_KEY=' /home/container/.secrets | cut -d= -f2 | tr -d '\r\n')"
[ -n "$KEY" ] || { echo '[setup] AGNES_API_KEY 缺失：请先把新 .secrets 上传到 /home/container/'; exit 1; }
printf 'AGNES_API_KEY=%s\n' "$KEY" > .env
chmod 600 .env

# 4) 装依赖（uv 自动拉 Python 3.11+，约 1-2 分钟）
echo "[setup] uv sync 开始"
"$UV" sync

# 5) 把 HORIZON_CMD/HORIZON_DIR 写进 .secrets（wxbot 启动时读，含 uv 绝对路径）
grep -q '^HORIZON_CMD=' /home/container/.secrets || \
  printf 'HORIZON_CMD=%s run horizon -c data/config.wxbot.json --hours 24\nHORIZON_DIR=/home/container/horizon\n' "$UV" >> /home/container/.secrets
chmod 600 /home/container/.secrets

# 6) 冒烟测试：生成一份日报（约 3-8 分钟；OOM 就重启容器再跑一次）
echo "[setup] 冒烟测试（生成一份日报，约 3-8 分钟）"
"$UV" run horizon -c data/config.wxbot.json --hours 12 -l WARNING

echo "[setup] ✅ Horizon 部署完成。wxbot 会自动通知微信；发「日报」即生效。"
