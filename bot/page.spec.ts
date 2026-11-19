import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// @ts-expect-error plain JS module shared with the browser
import { splitLinks } from './page/links.js'

const page = (file: string) => readFileSync(new URL(`./page/${file}`, import.meta.url), 'utf8')

test('index.html has no inline script, style or style attribute', () => {
  const html = page('index.html')
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i)
  assert.doesNotMatch(html, /<style/i)
  assert.doesNotMatch(html, /\sstyle=/i)
  assert.doesNotMatch(html, /\son[a-z]+=/i)
  assert.match(html, /<meta name="bot-token" content="__BOT_TOKEN__">/)
})

test('the page builds no HTML from strings', () => {
  for (const file of ['bot.js', 'links.js']) assert.doesNotMatch(page(file), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, file)
})

test('nothing loads from outside', () => {
  for (const file of ['index.html', 'bot.css']) assert.doesNotMatch(page(file), /https?:\/\//, file)
  assert.doesNotMatch(page('bot.js').replace('http://www.w3.org/2000/svg', ''), /https?:\/\//)
})

test('splitLinks makes links only for http and https', () => {
  assert.deepEqual(splitLinks('see [PR](https://x/1) and [bad](javascript:alert(1))'), [
    { text: 'see ' },
    { text: 'PR', href: 'https://x/1' },
    { text: ' and [bad](javascript:alert(1))' },
  ])
  assert.deepEqual(splitLinks('[a](http://h/p?q=1)'), [{ text: 'a', href: 'http://h/p?q=1' }])
  assert.deepEqual(splitLinks('plain'), [{ text: 'plain' }])
  assert.deepEqual(splitLinks(''), [])
  assert.deepEqual(splitLinks('[x](HTTPS://h/"onmouseover=1)'), [{ text: '[x](HTTPS://h/"onmouseover=1)' }])
})
