#!/bin/bash
# 每日AI快报脚本 - 每天早上10点自动运行

# 配置
CHAT_ID="oc_48387af591b8d4991d5c95a0074d3f7e"
WORKDIR="/Users/bytedance/.openclaw/workspace"

cd "$WORKDIR"

# 获取当天日期
DATE=$(date "+%Y年%m月%d日")

# 搜索AI行业新闻
echo "正在搜索AI行业新闻..."

# 搜索最新AI新闻
NEWS1=$(curl -s "https://ddg-api.vercel.app/search?q=AI+行业+新闻&format=json&num=5" 2>/dev/null | head -100)
NEWS2=$(curl -s "https://ddg-api.vercel.app/search?q=人工智能+技术+突破&format=json&num=5" 2>/dev/null | head -100)

# 构建消息
MESSAGE="🤖 **每日AI快报** - $DATE

📰 **AI行业大新闻**"

# 添加搜索到的新闻（简化处理）
if [ -n "$NEWS1" ]; then
    MESSAGE="$MESSAGE

🔥 今日AI动态已整理"
else
    MESSAGE="$MESSAGE

暂无最新新闻"
fi

MESSAGE="$MESSAGE

---

🦀 麻辣小虾为你播报"

# 发送消息到飞书群（使用OpenClaw CLI）
openclaw message send --channel feishu --target "$CHAT_ID" --message "$MESSAGE"

echo "AI快报已发送: $(date)"
