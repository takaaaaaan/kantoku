// The kantoku bot page. Data arrives as JSON from /api/bots and is placed
// with textContent only; the only markup built from data is <a> for http(s) links.
import { splitLinks } from './links.js'

const LABELS = {
  ja: {
    waiting: 'あなた待ち', working: '作業中', asleep: 'おやすみ中', info: '▸ 情報',
    askTag: 'あなたに聞きたいこと', recommended: '(おすすめ)', own: '自分で書く', answered: '答えた: ',
    sayTo: name => `${name} に話しかける…`, answerHint: '答えを書く…', send: '送る', sayLabel: 'メッセージ',
    hint: 'Enter で送る ・ Shift+Enter で改行', hintAnswer: 'Enter で答える ・ Esc でやめる',
    sent: '届けました', queued: '起きたら読みます', read: '読みました',
    description: '説明', wontDo: 'やらないこと: ', memory: '覚えていること', learned: d => `${d} に覚えた`,
    forget: '忘れて', fix: '直す', routines: 'ルーティン', stop: '止めてと頼む', skills: 'スキル', shared: 'みんなで共有',
    none: 'まだありません', editTitle: '説明を編集', descLabel: '説明(役割をひと段落で)', wontLabel: 'やらないこと(1行に1つ)',
    cancel: 'やめる', save: '保存', backupNote: '保存の前に今の内容を控えに取ります。',
    changed: 'ほかで変わっていました。もう一度どうぞ', stopText: name => `ルーティン「${name}」を止めて`,
    local: 'このPCの中だけで開いています', empty: 'マネージャーがまだいません',
    toastSent: name => `${name} に届けました`, toastQueued: name => `${name} は眠っています。起きたら読みます`,
    saved: '保存しました', forgot: '消しました(控えは残してあります)', failed: '送れませんでした。もう一度どうぞ',
    gear: '説明を編集', close: '閉じる', noTalk: 'まだ会話がありません',
  },
  en: {
    waiting: 'waiting for you', working: 'working', asleep: 'asleep', info: '▸ info',
    askTag: 'A question for you', recommended: ' (recommended)', own: 'Write my own', answered: 'Answered: ',
    sayTo: name => `Talk to ${name}…`, answerHint: 'Write your answer…', send: 'Send', sayLabel: 'Message',
    hint: 'Enter to send · Shift+Enter for a new line', hintAnswer: 'Enter to answer · Esc to stop',
    sent: 'delivered', queued: 'will read on waking', read: 'read',
    description: 'Description', wontDo: "Won't do: ", memory: 'Memory', learned: d => `learned ${d}`,
    forget: 'Forget', fix: 'Fix', routines: 'Routines', stop: 'Ask to stop', skills: 'Skills', shared: 'shared by all',
    none: 'Nothing yet', editTitle: 'Edit description', descLabel: 'Description (one paragraph)', wontLabel: "Won't do (one per line)",
    cancel: 'Cancel', save: 'Save', backupNote: 'The current text is backed up before saving.',
    changed: 'It changed elsewhere. Please try again', stopText: name => `Please stop the routine "${name}"`,
    local: 'Open on this PC only', empty: 'No managers yet',
    toastSent: name => `Delivered to ${name}`, toastQueued: name => `${name} is asleep and will read it on waking`,
    saved: 'Saved', forgot: 'Forgotten (a backup is kept)', failed: 'Could not send. Please try again',
    gear: 'Edit description', close: 'Close', noTalk: 'No conversation yet',
  },
}

const PASTELS = ['#f7a8b8', '#f5d06b', '#8ec5f0', '#a8dcb4', '#c9b3f0', '#f7b98a', '#9fd8d8', '#e6b3d9']
const MOOD = { waiting: 'smile', working: 'focus', asleep: 'sleep' }
const DOT = { waiting: 'wait', working: 'work', asleep: 'sleep' }
const SVG = 'http://www.w3.org/2000/svg'
const REFRESH_MS = 3000

const token = document.querySelector('meta[name="bot-token"]')?.getAttribute('content') ?? ''
const $ = id => document.getElementById(id)

let view = { bots: [], skills: [] }
let lastJson = ''
let selected = remembered()
let editing = false
let fixing = null // memory id being fixed
let answering = null // ask id being answered in the composer

// ---------- small helpers ----------

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG, tag)
  for (const key in attrs) node.setAttribute(key, String(attrs[key]))
  return node
}

function remembered() {
  try {
    return localStorage.getItem('kantoku-bot:selected') ?? ''
  } catch {
    return ''
  }
}

function remember(name) {
  try {
    localStorage.setItem('kantoku-bot:selected', name)
  } catch {
    // private window: nothing to keep
  }
}

function colorOf(name) {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return PASTELS[hash % PASTELS.length]
}

const bot = () => view.bots.find(b => b.name === selected)
const L = () => LABELS[bot()?.language ?? 'ja'] ?? LABELS.ja

function textWithLinks(text) {
  const span = el('span', 'text')
  for (const part of splitLinks(text)) {
    if (part.href) {
      const a = el('a', null, part.text)
      a.href = part.href
      a.rel = 'noopener noreferrer'
      a.target = '_blank'
      span.append(a)
    } else span.append(part.text)
  }
  return span
}

function dayOf(at) {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`
}

function timeOf(at) {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function toast(text) {
  const node = el('div', 'toast', text)
  node.setAttribute('role', 'status')
  document.body.append(node)
  setTimeout(() => node.remove(), 2400)
}

// Round face; eyes and mouth follow the status.
function face(b, big) {
  const span = el('span', 'face' + (big ? ' big' : ''))
  span.style.setProperty('--c', colorOf(b.name))
  const s = svgEl('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' })
  const ink = { stroke: '#1f2a33', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }
  s.append(svgEl('ellipse', { cx: 12, cy: 27, rx: 3, ry: 2, fill: '#fff', opacity: 0.5 }), svgEl('ellipse', { cx: 36, cy: 27, rx: 3, ry: 2, fill: '#fff', opacity: 0.5 }))
  const mood = MOOD[b.status]
  if (mood === 'sleep') s.append(svgEl('path', { d: 'M14 21q3 2 6 0M28 21q3 2 6 0', ...ink }))
  else s.append(svgEl('circle', { cx: 17, cy: 21, r: 2.6, fill: '#1f2a33' }), svgEl('circle', { cx: 31, cy: 21, r: 2.6, fill: '#1f2a33' }))
  if (mood === 'smile') s.append(svgEl('path', { d: 'M19 29q5 5 10 0', ...ink }))
  else if (mood === 'focus') s.append(svgEl('path', { d: 'M21 30h6', ...ink }))
  else s.append(svgEl('circle', { cx: 24, cy: 30, r: 1.8, fill: '#1f2a33' }))
  span.append(s, el('span', 'dot ' + DOT[b.status]))
  return span
}

function stateLabel(b, target) {
  target.textContent = LABELS[b.language][b.status]
  if (b.status === 'working') {
    const dots = el('span', 'typing')
    dots.append(el('i'), el('i'), el('i'))
    target.append(dots)
  }
}

// ---------- requests ----------

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': token },
      body: JSON.stringify(body),
    })
    let json = {}
    try {
      json = await res.json()
    } catch {
      // empty body
    }
    return { status: res.status, json }
  } catch {
    return { status: 0, json: {} }
  }
}

async function load(force) {
  let text
  try {
    const res = await fetch('/api/bots', { cache: 'no-store' })
    if (!res.ok) return
    text = await res.text()
  } catch {
    return
  }
  if (!force && text === lastJson) return
  lastJson = text
  view = JSON.parse(text)
  if (!bot()) selected = view.bots[0]?.name ?? ''
  render()
}

// ---------- rendering ----------

function render() {
  renderList()
  renderChat()
  renderSheet()
}

function renderList() {
  const l = L()
  $('sideFoot').textContent = l.local
  const ul = $('bots')
  ul.textContent = ''
  for (const b of view.bots) {
    const li = el('li')
    const row = el('button', 'bot-row')
    row.type = 'button'
    row.setAttribute('aria-current', b.name === selected ? 'true' : 'false')
    const mid = el('div')
    mid.append(el('div', 'name', b.name), el('div', 'say', b.line))
    row.append(face(b), mid, b.status === 'waiting' ? el('span', 'wait-pill', LABELS[b.language].waiting) : el('span'))
    row.addEventListener('click', () => select(b.name))
    li.append(row)
    ul.append(li)
  }
}

function select(name) {
  if (name === selected) return
  selected = name
  remember(name)
  editing = false
  fixing = null
  stopAnswering()
  render()
  scrollChat(true)
}

function scrollChat(force) {
  const chat = $('chat')
  if (force || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80) chat.scrollTop = chat.scrollHeight
}

function renderChat() {
  const b = bot()
  const l = L()
  const chat = $('chat')
  const stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80
  const head = $('headName')
  head.textContent = ''
  $('headState').textContent = ''
  chat.textContent = ''
  $('composer').hidden = !b
  $('hint').hidden = !b
  if (!b) {
    chat.append(el('p', 'empty', l.empty))
    return
  }
  head.append(face(b), el('strong', null, b.name), el('span', 'chev', l.info))
  stateLabel(b, $('headState'))
  $('sayLabel').textContent = l.sayLabel
  $('sendBtn').textContent = l.send
  $('say').placeholder = answering ? l.answerHint : l.sayTo(b.name)
  $('hint').textContent = answering ? l.hintAnswer : l.hint
  if (b.talk.length === 0) chat.append(el('p', 'empty', l.noTalk))
  let day = ''
  for (const item of b.talk) {
    const d = dayOf(item.at)
    if (d && d !== day) {
      chat.append(el('div', 'day', d))
      day = d
    }
    chat.append(item.kind === 'mine' ? mineBubble(item, l) : botBubble(b, item, l))
  }
  if (stick) scrollChat(true)
}

function mineBubble(item, l) {
  const msg = el('div', 'msg mine')
  const bubble = el('div', 'bubble')
  bubble.append(textWithLinks(item.text), el('time', null, `${timeOf(item.at)} ・ ${l[item.delivery]}`))
  msg.append(bubble)
  return msg
}

function botBubble(b, item, l) {
  const msg = el('div', 'msg')
  const bubble = el('div', 'bubble' + (item.kind === 'ask' ? ' ask' : ''))
  if (item.kind === 'ask') bubble.append(el('span', 'tag', l.askTag))
  bubble.append(textWithLinks(item.text))
  if (item.kind === 'ask' && item.answer === undefined) {
    const row = el('div', 'choices')
    for (const choice of item.choices) {
      const button = el('button', 'choice' + (choice.recommended ? ' rec' : ''), choice.label + (choice.recommended ? l.recommended : ''))
      button.type = 'button'
      button.addEventListener('click', () => answerWith(b, item, { choice: choice.label }, row))
      row.append(button)
    }
    const own = el('button', 'choice', l.own)
    own.type = 'button'
    own.addEventListener('click', () => startAnswering(item.id))
    row.append(own)
    bubble.append(row)
  }
  if (item.kind === 'ask' && item.answer !== undefined) bubble.append(el('div', 'answered', l.answered + item.answer))
  bubble.append(el('time', null, timeOf(item.at)))
  msg.append(face(b), bubble)
  return msg
}

function renderSheet() {
  const b = bot()
  const l = L()
  $('gear').hidden = !b
  $('gear').setAttribute('aria-label', l.gear)
  $('close').setAttribute('aria-label', l.close)
  $('memoryTitle').textContent = l.memory
  $('routinesTitle').textContent = l.routines
  $('skillsTitle').textContent = l.skills
  $('skillsShared').textContent = l.shared
  if (!b) return
  const top = $('sheetFace')
  top.textContent = ''
  top.append(face(b, true))
  $('sheetName').textContent = b.name
  stateLabel(b, $('sheetState'))
  if (!editing) renderDescription(b, l)
  if (fixing === null) renderMemory(b, l)
  renderRoutines(b, l)
  const skills = $('skills')
  skills.textContent = ''
  for (const skill of view.skills) skills.append(el('span', 'chip', skill))
  if (view.skills.length === 0) skills.append(el('span', 'note', l.none))
}

function renderDescription(b, l) {
  const sec = $('descSec')
  sec.textContent = ''
  sec.append(el('h3', null, l.description), el('p', 'text', b.description || l.none))
  if (b.wontDo.length > 0) {
    const nots = el('p', 'nots')
    nots.append(el('b', null, l.wontDo), b.wontDo.join(b.language === 'ja' ? '、' : ', '))
    sec.append(nots)
  }
}

function renderEditForm(b, l) {
  const sec = $('descSec')
  sec.textContent = ''
  const form = el('form', 'edit')
  const descLabel = el('label', null, l.descLabel)
  descLabel.htmlFor = 'editDesc'
  const desc = el('textarea')
  desc.id = 'editDesc'
  desc.rows = 5
  desc.maxLength = 2000
  desc.value = b.description
  const wontLabel = el('label', null, l.wontLabel)
  wontLabel.htmlFor = 'editNots'
  const wont = el('textarea')
  wont.id = 'editNots'
  wont.rows = 3
  wont.value = b.wontDo.join('\n')
  const error = el('p', 'error')
  error.hidden = true
  const row = el('div', 'edit-row')
  const cancel = el('button', 'btn', l.cancel)
  cancel.type = 'button'
  cancel.addEventListener('click', () => {
    editing = false
    renderSheet()
  })
  const save = el('button', 'btn primary', l.save)
  save.type = 'submit'
  form.addEventListener('submit', async event => {
    event.preventDefault()
    save.disabled = true
    const wontDo = wont.value.split('\n').map(s => s.trim()).filter(Boolean)
    const res = await post('/api/profile', { bot: b.name, version: b.version.profile, description: desc.value.trim(), wontDo })
    save.disabled = false
    if (res.status === 200) {
      editing = false
      toast(l.saved)
      await load(true)
    } else if (res.status === 409) {
      editing = false
      toast(l.changed)
      await load(true)
    } else {
      error.textContent = res.json.error ?? l.failed
      error.hidden = false
    }
  })
  row.append(cancel, save)
  form.append(el('h3', null, l.editTitle), descLabel, desc, wontLabel, wont, error, row, el('p', 'note', l.backupNote))
  sec.append(form)
  desc.focus()
}

function renderMemory(b, l) {
  const list = $('memory')
  list.textContent = ''
  if (b.memory.length === 0) list.append(el('li', null, l.none))
  for (const m of b.memory) {
    const li = el('li')
    const text = el('div', 'text', m.fact)
    if (m.date) text.append(el('small', null, l.learned(m.date)))
    const buttons = el('div', 'mini-row')
    const fix = el('button', 'mini', l.fix)
    fix.type = 'button'
    fix.addEventListener('click', () => {
      fixing = m.id
      renderFixRow(b, l, li, text, m)
    })
    const forget = el('button', 'mini del', l.forget)
    forget.type = 'button'
    forget.addEventListener('click', async () => {
      forget.disabled = true
      const res = await post('/api/memory/forget', { bot: b.name, version: b.version.memory, id: m.id })
      toast(res.status === 200 ? l.forgot : res.status === 409 ? l.changed : (res.json.error ?? l.failed))
      await load(true)
    })
    buttons.append(fix, forget)
    li.append(text, buttons)
    list.append(li)
  }
}

function renderFixRow(b, l, li, text, m) {
  li.textContent = ''
  const form = el('form', 'fix-row')
  const input = el('input')
  input.value = m.fact
  input.maxLength = 300
  input.setAttribute('aria-label', l.fix)
  const save = el('button', 'mini', l.save)
  save.type = 'submit'
  const cancel = el('button', 'mini', l.cancel)
  cancel.type = 'button'
  const done = async () => {
    fixing = null
    await load(true)
    renderMemory(bot() ?? b, l)
  }
  cancel.addEventListener('click', done)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const res = await post('/api/memory/fix', { bot: b.name, version: b.version.memory, id: m.id, fact: input.value.trim() })
    toast(res.status === 200 ? l.saved : res.status === 409 ? l.changed : (res.json.error ?? l.failed))
    await done()
  })
  form.append(input, save, cancel)
  li.append(form)
  input.focus()
}

function renderRoutines(b, l) {
  const list = $('routines')
  list.textContent = ''
  if (b.routines.length === 0) list.append(el('li', null, l.none))
  for (const r of b.routines) {
    const li = el('li')
    const text = el('div', null, [r.name, r.when].filter(Boolean).join(' ・ '))
    text.append(el('small', null, r.what))
    const stop = el('button', 'mini', l.stop)
    stop.type = 'button'
    stop.addEventListener('click', async () => {
      stop.disabled = true
      await say(b, l.stopText(r.name))
      stop.disabled = false
    })
    li.append(text, stop)
    list.append(li)
  }
}

// ---------- talking and answering ----------

async function say(b, text) {
  const l = LABELS[b.language]
  const res = await post('/api/say', { bot: b.name, text })
  if (res.status !== 200) {
    toast(res.json.error ?? l.failed)
    return false
  }
  toast(res.json.delivery === 'sent' ? l.toastSent(b.name) : l.toastQueued(b.name))
  await load(true)
  scrollChat(true)
  return true
}

async function answerWith(b, item, answer, row) {
  const l = LABELS[b.language]
  for (const button of row?.querySelectorAll('button') ?? []) button.disabled = true
  const res = await post('/api/answer', { bot: b.name, ask: item.id, ...answer })
  if (res.status === 200) toast(res.json.delivery === 'sent' ? l.toastSent(b.name) : l.toastQueued(b.name))
  else toast(res.json.error ?? l.failed)
  await load(true)
  return res.status === 200
}

function startAnswering(askId) {
  answering = askId
  $('composer').classList.add('answering')
  renderChat()
  $('say').focus()
}

function stopAnswering() {
  answering = null
  $('composer').classList.remove('answering')
}

const sayBox = $('say')
const sendBtn = $('sendBtn')

function resizeSayBox() {
  sendBtn.disabled = sayBox.value.trim() === ''
  sayBox.style.height = 'auto'
  sayBox.style.height = `${sayBox.scrollHeight + sayBox.offsetHeight - sayBox.clientHeight}px`
}

sayBox.addEventListener('input', resizeSayBox)
sayBox.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    $('composer').requestSubmit()
  } else if (event.key === 'Escape' && answering) {
    event.stopPropagation()
    stopAnswering()
    renderChat()
  }
})

$('composer').addEventListener('submit', async event => {
  event.preventDefault()
  const b = bot()
  const text = sayBox.value.trim()
  if (!b || text === '') return
  sendBtn.disabled = true
  // Answer by id even if the ask scrolled out of the newest 100; the server checks it.
  const ok = answering ? await answerWith(b, { id: answering }, { text }) : await say(b, text)
  if (ok) {
    sayBox.value = ''
    stopAnswering()
    renderChat()
  }
  resizeSayBox()
})

// ---------- info sheet ----------

const sheet = $('sheet')
const scrim = $('scrim')

function openSheet(open) {
  sheet.classList.toggle('open', open)
  scrim.classList.toggle('open', open)
  sheet.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (open) $('close').focus()
  else {
    editing = false
    fixing = null
    renderSheet()
    $('headName').focus()
  }
}

$('headName').addEventListener('click', () => bot() && openSheet(true))
$('close').addEventListener('click', () => openSheet(false))
scrim.addEventListener('click', () => openSheet(false))
$('gear').addEventListener('click', () => {
  const b = bot()
  if (!b) return
  editing = !editing
  if (editing) renderEditForm(b, L())
  else renderSheet()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sheet.classList.contains('open')) openSheet(false)
})

// ---------- start ----------

await load(true)
scrollChat(true)
setInterval(() => {
  if (document.visibilityState === 'visible') void load(false)
}, REFRESH_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load(false)
})
