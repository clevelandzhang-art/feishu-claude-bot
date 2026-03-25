const express = require('express')
const OpenAI = require('openai')
const Redis = require('ioredis')
const { tavily } = require('@tavily/core')

const app = express()
app.use(express.json())

// ── 客户端初始化 ──────────────────────────────────────────
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1', 
  apiKey: process.env.OPENROUTER_API_KEY,
})

const redis = new Redis(process.env.REDIS_URL)

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY })

// ── 常量配置 ──────────────────────────────────────────────
const MODEL = 'anthropic/claude-sonnet-4.6'
const MAX_HISTORY = 20
const HISTORY_TTL = 60 * 60 * 24 * 7  // 7天

// ── 搜索触发判断 ──────────────────────────────────────────
function needsSearch(text) {
  const t = text.toLowerCase()

  const explicitCommands = [
    '帮我搜', '帮我查', '搜索', '查一下', '查下', '搜一下',
    '搜一搜', '帮我找', '找一下', '找下', '查询', '查资料',
    '搜资料', '网上查', '网上搜', '联网搜', '联网查',
    'search', 'look up', 'google', 'find me'
  ]
  if (explicitCommands.some(kw => t.includes(kw))) return true

  const timeKeywords = [
    '最新', '今天', '现在', '最近', '新闻', '今年', '当前',
    '实时', '价格', '股价', '天气', '比赛', '结果', '发布',
    '最近几天', '这周', '本周', '本月', '今晚', '今日',
    'latest', 'today', 'now', 'news', 'current', 'price', 'weather', 'recent'
  ]
  return timeKeywords.some(kw => t.includes(kw))
}

// ── 工具函数 ──────────────────────────────────────────────
const processedIds = new Set()

async function searchWeb(query) {
  try {
    const result = await tavilyClient.search(query, {
      maxResults: 3,
      searchDepth: 'basic',
    })
    if (!result.results || result.results.length === 0) return null
    return result.results
      .map(r => `【${r.title}】\n${r.content}\n来源：${r.url}`)
      .join('\n\n')
  } catch (e) {
    console.error('Tavily search error:', e.message)
    return null
  }
}

async function getHistory(openId) {
  try {
    const raw = await redis.get(`history:${openId}`)
    return raw ? JSON.parse(raw) : []
  } catch (e) {
    console.error('Redis get error:', e.message)
    return []
  }
}

async function saveHistory(openId, history) {
  try {
    const trimmed = history.slice(-MAX_HISTORY)
    await redis.set(`history:${openId}`, JSON.stringify(trimmed), 'EX', HISTORY_TTL)
  } catch (e) {
    console.error('Redis set error:', e.message)
  }
}

async function getTenantAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  })
  const data = await res.json()
  return data.tenant_access_token
}

async function sendFeishuMessage(openId, text) {
  const token = await getTenantAccessToken()
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  })
  const data = await res.json()
  console.log('sendFeishuMessage result:', JSON.stringify(data))
}

// ── 核心处理逻辑 ──────────────────────────────────────────
async function handleMessage(event, message) {
  const messageId = message.message_id ?? ''
  if (processedIds.has(messageId)) return
  processedIds.add(messageId)

  if (message.message_type !== 'text') return

  let userText = ''
  try {
    const content = JSON.parse(message.content ?? '{}')
    userText = (content.text ?? '').trim()
    if (userText.includes('@')) {
      userText = userText.split(' ').filter(p => !p.startsWith('@')).join(' ').trim()
    }
  } catch {
    return
  }

  if (!userText) return

  const openId = event.sender?.sender_id?.open_id ?? ''
  if (!openId) return

  console.log(`[${openId}] 用户说: ${userText}`)

  try {
    // 1. 读取历史对话
    const history = await getHistory(openId)

    // 2. 判断是否需要联网搜索
    let systemPrompt = '你是一个智能助手，请用中文回答问题，回答简洁清晰。'
    if (needsSearch(userText)) {
      console.log(`[${openId}] 触发联网搜索: ${userText}`)
      const searchResult = await searchWeb(userText)
      if (searchResult) {
        systemPrompt += `\n\n以下是联网搜索到的最新信息，请结合这些信息回答用户问题：\n\n${searchResult}`
        console.log(`[${openId}] 搜索成功，已注入上下文`)
      } else {
        console.log(`[${openId}] 搜索无结果，使用模型自身知识回答`)
      }
    }

    // 3. 组装消息
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userText },
    ]

    // 4. 调用 Claude，禁止 fallback 降级
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: 1024,
    }, {
      headers: {
        'X-OR-No-Fallback': '1',
      },
    })

    const reply = response.choices[0].message.content
    const usedModel = response.model
    console.log(`[${openId}] 回复完成，实际使用模型: ${usedModel}`)

    // 5. 保存对话历史
    history.push({ role: 'user', content: userText })
    history.push({ role: 'assistant', content: reply })
    await saveHistory(openId, history)

    // 6. 发送飞书消息
    await sendFeishuMessage(openId, reply)

  } catch (e) {
    console.error('handleMessage error:', e.message)
    await sendFeishuMessage(openId, `出错了：${e.message}`)
  }
}

// ── 路由 ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Claude飞书机器人运行中', model: MODEL })
})

app.post('/api/webhook', (req, res) => {
  const payload = req.body ?? {}
  console.log('收到请求:', JSON.stringify(payload))

  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge })
  }

  res.json({ msg: 'ok' })

  const event = payload.event ?? {}
  const message = event.message ?? {}
  handleMessage(event, message).catch(e => console.error('handleMessage error:', e.message))
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Server running on port ${port}, model: ${MODEL}`)
})