import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitText } from '../lib/index.js'

test('短文本不分片', () => {
  assert.deepEqual(splitText('hello', 4096), ['hello'])
})

test('恰好等于上限不分片', () => {
  assert.deepEqual(splitText('a'.repeat(100), 100), ['a'.repeat(100)])
})

test('超过上限按字符切分', () => {
  const parts = splitText('x'.repeat(250), 100)
  assert.ok(parts.length >= 3)
  for (const p of parts) assert.ok([...p].length <= 100, `part too long: ${p.length}`)
  assert.equal(parts.join('').replace(/（\d+\/\d+）/g, ''), 'x'.repeat(250))
})

test('中文文本在句号处断行', () => {
  const text = '第一句话。第二句话。第三句话。第四句话。'
  const parts = splitText(text, 10)
  for (let i = 0; i < parts.length - 1; i += 1) {
    const body = parts[i].replace(/（\d+\/\d+）/, '')
    assert.ok(body.endsWith('。'), `段 ${i} 未在句号断行: ${body}`)
  }
  assert.equal(parts.join('').replace(/（\d+\/\d+）/g, ''), text)
})

test('前缀带分段序号且收敛', () => {
  const parts = splitText('y'.repeat(300), 120)
  assert.ok(parts.length >= 3)
  const last = parts[parts.length - 1]
  const m = last.match(/（(\d+)\/(\d+)）/)
  assert.ok(m, '最后一段应有前缀')
  assert.equal(Number(m[1]), parts.length)
  assert.equal(Number(m[2]), parts.length)
})

test('换行优先断行', () => {
  const text = 'line1\nline2\nline3\nline4\nline5\n'
  const parts = splitText(text, 12)
  for (let i = 0; i < parts.length - 1; i += 1) {
    const body = parts[i].replace(/（\d+\/\d+）/, '')
    assert.ok(body.endsWith('\n'), `段 ${i} 未在换行断行: ${JSON.stringify(body)}`)
  }
})

test('空文本返回空数组', () => {
  assert.deepEqual(splitText('', 100), [])
})

test('max=0 时原样返回', () => {
  assert.deepEqual(splitText('abc', 0), ['abc'])
})