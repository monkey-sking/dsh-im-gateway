import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionMerger, stripControlSuffix } from '../lib/index.js'

function makeMerger(timeoutMs = 5000) {
  const flushed = []
  const snapshots = []
  const merger = new SessionMerger({
    mergeTimeoutMs: timeoutMs,
    onSnapshot: (k, b) => snapshots.push([k, b]),
    onFlush: (k, t) => flushed.push([k, t]),
  })
  return { merger, flushed, snapshots }
}

test('stripControlSuffix 识别 .. 与 !!', () => {
  assert.deepEqual(stripControlSuffix('abc..'), { text: 'abc', control: 'continue' })
  assert.deepEqual(stripControlSuffix('abc!!'), { text: 'abc', control: 'commit' })
  assert.deepEqual(stripControlSuffix('abc'), { text: 'abc', control: 'none' })
})

test('裸文本进合并窗口（buffered）', () => {
  const { merger, flushed } = makeMerger(1000)
  const r = merger.ingest('k1', '第一条')
  assert.equal(r.kind, 'buffered')
  assert.equal(flushed.length, 0)
})

test('.. 续传后裸文本合并提交', () => {
  const { merger, flushed } = makeMerger(1000)
  merger.ingest('k1', '第一段..')
  const r = merger.ingest('k1', '第二段')
  assert.equal(r.kind, 'flushed')
  assert.equal(r.text, '第一段第二段')
})

test('!! 立即提交', () => {
  const { merger, flushed } = makeMerger(1000)
  const r = merger.ingest('k1', '立即发!!')
  assert.equal(r.kind, 'flushed')
  assert.equal(r.text, '立即发')
})

test('超时后 flush 缓冲', async () => {
  const { merger, flushed } = makeMerger(50)
  merger.ingest('k1', '超时消息')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0][0], 'k1')
  assert.equal(flushed[0][1], '超时消息')
})

test('restore 恢复崩溃缓冲并在超时后提交', async () => {
  const { merger, flushed } = makeMerger(50)
  merger.restore('k1', '崩溃前未提交')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0][1], '崩溃前未提交')
})

test('snapshots 返回全部缓冲', () => {
  const { merger } = makeMerger(1000)
  merger.ingest('k1', 'a..')
  merger.ingest('k2', 'b..')
  const s = merger.snapshots()
  assert.equal(s['k1'], 'a')
  assert.equal(s['k2'], 'b')
})

test('空白消息 ignored', () => {
  const { merger } = makeMerger(1000)
  const r = merger.ingest('k1', '   ')
  assert.equal(r.kind, 'ignored')
})

test('dispose 清理定时器', () => {
  const { merger, flushed } = makeMerger(50)
  merger.ingest('k1', '将被清理')
  merger.dispose()
  return new Promise((r) => setTimeout(() => {
    assert.equal(flushed.length, 0)
    r()
  }, 150))
})