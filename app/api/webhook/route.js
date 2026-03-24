import { NextResponse } from 'next/server'
import OpenAI from 'openai'

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
  await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',  {
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
}

async function askClaude(userMessage) {
  const response = await client.chat.completions.create({
    model: 'anthropic/claude-sonnet-4-5',
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 1024,
  })
  return response.choices[0].message.content
}

export async function GET() {
  return NextResponse.json({ status: 'Claude飞书机器人运行中' })
}

export async function POST(request) {
  const payload = await request.json().catch(() => ({}))

  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const event = payload.event ?? {}
  const message = event.message ?? {}
  const messageId = message.message_id ?? ''

  if (processedIds.has(messageId)) {
    return NextResponse.json({ msg: 'duplicate' })
  }
  processedIds.add(messageId)

  if (message.message_type !== 'text') {
    return NextResponse.json({ msg: 'ignored' })
  }

  let userText = ''
  try {
    const content = JSON.parse(message.content ?? '{}')
    userText = (content.text ?? '').trim()
    if (userText.includes('@')) {
      userText = userText.split(' ').filter(p => !p.startsWith('@')).join(' ').trim()
    }
  } catch {
    return NextResponse.json({ msg: 'parse error' })
  }

  if (!userText) return NextResponse.json({ msg: 'empty' })

  const openId = event.sender?.sender_id?.open_id ?? ''
  if (!openId) return NextResponse.json({ msg: 'no open_id' })

  try {
    const reply = await askClaude(userText)
    await sendFeishuMessage(openId, reply)
  } catch (e) {
    await sendFeishuMessage(openId, `出错了：${e.message}`)
  }

  return NextResponse.json({ msg: 'ok' })
}