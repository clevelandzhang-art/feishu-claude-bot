const express = require('express')
const OpenAI = require('openai')

const app = express()
app.use(express.json())

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1', 
  apiKey: process.env.OPENROUTER_API_KEY,
})

const processedIds = new Set()

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

  console.log('calling Claude for:', userText)
  try {
    const response = await client.chat.completions.create({
      model: 'anthropic/claude-sonnet-4-5',
      messages: [{ role: 'user', content: userText }],
      max_tokens: 1024,
    })
    const reply = response.choices[0].message.content
    console.log('Claude replied, sending to feishu...')
    await sendFeishuMessage(openId, reply)
  } catch (e) {
    console.error('error:', e.message)
    await sendFeishuMessage(openId, `出错了：${e.message}`)
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'Claude飞书机器人运行中' })
})

app.post('/api/webhook', (req, res) => {
  const payload = req.body ?? {}

  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge })
  }

  // 立即返回，异步处理
  res.json({ msg: 'ok' })

  const event = payload.event ?? {}
  const message = event.message ?? {}
  handleMessage(event, message).catch(e => console.error('handleMessage error:', e.message))
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})