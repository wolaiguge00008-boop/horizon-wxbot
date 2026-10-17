# horizon-wxbot（零密钥公开仓库）

Le-ge 云端微信机器人的 Horizon 深度新闻引擎。本仓库**不含任何密钥**：
key 由部署脚本从服务器 600 权限的 `/home/container/.secrets` 读取生成 `.env`。

## VPS 部署（Pterodactyl "爱马仕" 容器）

```bash
# 在面板 Console 里执行（一次性）：
bash /home/container/horizon-setup.sh
```

setup 脚本做 6 件事：装 uv → clone 本仓库到 /home/container/horizon → 从 .secrets 生成 .env(600) → uv sync 装依赖 → 把 HORIZON_CMD/HORIZON_DIR 写进 .secrets → 冒烟生成一份日报。

## 按需触发（无 cron、无轮询）

wxbot（/home/container/index.js）收到微信消息含「日报」才跑一次：

```
微信发"日报" → 回"开始生成…约3-8分钟" → 后台跑 horizon → 读完 data/summaries/horizon-<日期>-zh.md → 自动分段推回微信
```

平时 0 后台任务。

## 配置

- `data/config.wxbot.json`：Agnes（OpenAI 兼容）+ GDELT/Google News 免 key 源，24h 窗口，digest 15 条
- 换源/换主题：改该 JSON 的 `sources`（gdelt.query / google_news.query）
- 换模型：改 `ai.model`（需 Agnes 渠道有的模型，如 agnes-3.0-flash）

## 本地开发

```bash
cp .env.example .env   # 填 AGNES_API_KEY
uv sync
uv run horizon -c data/config.wxbot.json --hours 24
```
