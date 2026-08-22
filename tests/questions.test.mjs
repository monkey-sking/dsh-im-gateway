import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuestionBroker, formatQuestionPrompt, parseQuestionReply } from '../lib/index.js'

const single = [{ id: 'mode', header: '选择模式', question: '请选择运行模式', options: [{ label: '快速' }, { label: '完整', description: '执行全部检查' }] }]

test('单选支持编号、标签与自定义答案', () => {
  assert.deepEqual(parseQuestionReply(single, '2'), { ok: true, answer: { answers: [{ id: 'mode', selected: ['完整'] }] } })
  assert.deepEqual(parseQuestionReply(single, '快速'), { ok: true, answer: { answers: [{ id: 'mode', selected: ['快速'] }] } })
  assert.deepEqual(parseQuestionReply(single, '以后再说'), { ok: true, answer: { answers: [{ id: 'mode', selected: [], custom: '以后再说' }] } })
})

test('多选支持编号、标签和自定义值混合', () => {
  assert.deepEqual(parseQuestionReply([{ ...single[0], multiSelect: true }], '1,完整,其他'), { ok: true, answer: { answers: [{ id: 'mode', selected: ['快速', '完整'], custom: '其他' }] } })
})

test('自由文本和多问题逐行回答', () => {
  assert.deepEqual(parseQuestionReply([{ id: 'name', question: '项目名？' }], 'dsh-im-gateway'), { ok: true, answer: { answers: [{ id: 'name', selected: [], custom: 'dsh-im-gateway' }] } })
  const questions = [single[0], { id: 'features', question: '选择功能', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }]
  assert.deepEqual(parseQuestionReply(questions, '1: 2\n2: 1,2'), { ok: true, answer: { answers: [{ id: 'mode', selected: ['完整'] }, { id: 'features', selected: ['A', 'B'] }] } })
  assert.equal(parseQuestionReply(questions, '1: 1').ok, false)
})

test('QuestionBroker 第一答生效、迟到回答拦截', async () => {
  const broker = new QuestionBroker()
  const wait = broker.wait('s1', single, 1000)
  assert.equal(broker.answer('s1', '1', { channelId: 'qq', conversationId: 'c1', label: 'QQ' }).kind, 'answered')
  const result = await wait
  assert.equal(result.kind, 'answered')
  assert.deepEqual(result.answer.answers[0].selected, ['快速'])
  const late = broker.answer('s1', '2', { channelId: 'wechat', conversationId: 'c2' })
  assert.equal(late.kind, 'already-answered')
  assert.match(late.message, /QQ/)
  broker.dispose()
})

test('QuestionBroker Web 回答与超时清理', async () => {
  const broker = new QuestionBroker()
  const webWait = broker.wait('web', single, 1000)
  broker.finishFromWeb('web', { answers: [{ id: 'mode', selected: ['完整'] }] })
  assert.equal((await webWait).kind, 'external')
  const timeoutWait = broker.wait('timeout', single, 20)
  assert.equal((await timeoutWait).kind, 'timeout')
  assert.equal(broker.hasPending('timeout'), false)
  broker.dispose()
})

test('无效多问题回答保持 pending，修正后可继续回答', async () => {
  const broker = new QuestionBroker()
  const questions = [single[0], { id: 'name', question: '项目名？' }]
  const wait = broker.wait('retry', questions, 1000)
  assert.equal(broker.answer('retry', '1: 1', { channelId: 'qq', conversationId: 'c1' }).kind, 'invalid')
  assert.equal(broker.hasPending('retry'), true)
  assert.equal(broker.answer('retry', '1: 1\n2: gateway', { channelId: 'qq', conversationId: 'c1' }).kind, 'answered')
  assert.equal((await wait).kind, 'answered')
  broker.dispose()
})

test('不同 session 的 pending 和答案互不影响', async () => {
  const broker = new QuestionBroker()
  const first = broker.wait('s1', single, 1000)
  const second = broker.wait('s2', single, 1000)
  broker.answer('s1', '1', { channelId: 'qq', conversationId: 'c1' })
  assert.equal((await first).kind, 'answered')
  assert.equal(broker.hasPending('s2'), true)
  broker.answer('s2', '2', { channelId: 'wechat', conversationId: 'c2' })
  assert.deepEqual((await second).answer.answers[0].selected, ['完整'])
  broker.dispose()
})

test('问题提示包含选项、说明与多问题回答格式', () => {
  const text = formatQuestionPrompt([single[0], { id: 'name', question: '项目名？' }], 600)
  assert.match(text, /1\) 快速/)
  assert.match(text, /2\) 完整 — 执行全部检查/)
  assert.match(text, /1: 2/)
})