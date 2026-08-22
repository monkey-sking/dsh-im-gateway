import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalBroker } from '../lib/index.js'

test('wait 后 answer 放行', async () => {
  const broker = new ApprovalBroker()
  const p = broker.wait('s1', 1000)
  assert.equal(broker.hasPending('s1'), true)
  assert.equal(broker.answer('s1', true), true)
  assert.equal(await p, 'allow')
  assert.equal(broker.hasPending('s1'), false)
})

test('answer 拒绝', async () => {
  const broker = new ApprovalBroker()
  const p = broker.wait('s1', 1000)
  broker.answer('s1', false)
  assert.equal(await p, 'reject')
})

test('超时返回 undefined', async () => {
  const broker = new ApprovalBroker()
  const p = broker.wait('s1', 30)
  assert.equal(await p, undefined)
})

test('多会话并发 pending 互不干扰', async () => {
  const broker = new ApprovalBroker()
  const p1 = broker.wait('a', 1000)
  const p2 = broker.wait('b', 1000)
  broker.answer('b', true)
  assert.equal(await p2, 'allow')
  broker.answer('a', false)
  assert.equal(await p1, 'reject')
})

test('同 key 重复 wait 立即返回 undefined', async () => {
  const broker = new ApprovalBroker()
  broker.wait('s1', 1000)
  const second = broker.wait('s1', 1000)
  assert.equal(await second, undefined)
})

test('signal 中止返回 undefined', async () => {
  const broker = new ApprovalBroker()
  const ac = new AbortController()
  const p = broker.wait('s1', 1000, ac.signal)
  ac.abort()
  assert.equal(await p, undefined)
})

test('无 pending 时 answer 返回 false', () => {
  const broker = new ApprovalBroker()
  assert.equal(broker.answer('s1', true), false)
})

test('dispose 清理所有 pending', async () => {
  const broker = new ApprovalBroker()
  const p = broker.wait('s1', 5000)
  broker.dispose()
  assert.equal(await p, undefined)
})