import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDesignDraft, EMPTY_DRAFT, createDraftBatch } from '../lib/design-draft.ts'
import { createDraftContext } from '../lib/draft-context.ts'

const chunk = (delta, offset=0, extra={}) => ({type:'design_draft',draftId:'attempt:call',draftRevision:1,turnId:1,artifactRevision:0,draftOffset:offset,delta,...extra})

test('reconnect prefixes and overlap do not duplicate HTML, including unicode', () => {
  let state=applyDesignDraft(EMPTY_DRAFT,chunk('<body>😀'),0)
  state=applyDesignDraft(state,chunk('<body>😀<h1>Hello</h1>'),0)
  state=applyDesignDraft(state,chunk('<body>😀<h1>Hello</h1>'),0)
  assert.equal(state.draft.html,'<body>😀<h1>Hello</h1>')
  assert.equal(applyDesignDraft(state,chunk('bad',100),0),state,'a gap is not appended')
  assert.equal(applyDesignDraft(state,chunk('wrong',0),0),state,'a mismatched prefix is not appended')
})

test('ended, aborted and published drafts cannot reappear; a new turn can stream', () => {
  const started=applyDesignDraft(EMPTY_DRAFT,chunk('old'),0)
  for(const end of [{type:'done',turnId:1},{type:'error',turnId:1},chunk('',0,{draftClosed:true})]) {
    const closed=applyDesignDraft(started,end,0)
    assert.equal(applyDesignDraft(closed,chunk('old'),0).draft,null)
  }
  const published=applyDesignDraft(started,{type:'artifact',artifactRevision:1},1)
  assert.equal(applyDesignDraft(published,chunk('old'),1).draft,null)
  const done=applyDesignDraft(started,{type:'done',turnId:1},0)
  const next=applyDesignDraft(done,chunk('new',0,{draftId:'next:call',draftRevision:2,turnId:2}),0)
  assert.equal(next.draft.html,'new')
  assert.equal(applyDesignDraft(next,chunk('old'),0),next)
})

test('a complete new attempt replaces the old prefix, rather than extending it', () => {
  let state=applyDesignDraft(EMPTY_DRAFT,chunk('old'),0)
  state=applyDesignDraft(state,chunk('new',0,{draftId:'retry:call',draftRevision:2}),0)
  assert.equal(state.draft.html,'new')
})

test('a publish close holds the last picture until the artifact event, without accepting later bytes', () => {
  let state=applyDesignDraft(EMPTY_DRAFT,chunk('picture'),0)
  state=applyDesignDraft(state,chunk('',0,{draftClosed:true,draftPublished:true}),0)
  assert.equal(state.draft.html,'picture')
  assert.equal(applyDesignDraft(state,chunk('picture late'),0),state)
  state=applyDesignDraft(state,{type:'artifact',artifactRevision:1},1)
  assert.equal(state.draft,null)
})

test('tool argument end flushes the batch and leaves no late timer', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const output=[]
  const batch=createDraftBatch(async(id,delta)=>output.push([id,delta]))
  batch.delta('call','<body>')
  batch.delta('call','hello')
  await batch.end('call')
  output.push('artifact','done')
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.deepEqual(output,[['call','<body>hello'],'artifact','done'])
})

test('prompt diagnostics bind a durable turn, not a later queued message', () => {
  const context=createDraftContext()
  context.observe({type:'acp.send',message:{method:'session/prompt',params:{sessionId:'session',_meta:{fx:{turnId:'m3'}}}}})
  assert.equal(context.turn('session'),3)
  context.observe({type:'acp.send',message:{method:'libfx/follow_up',params:{sessionId:'session',id:'m4'}}})
  assert.equal(context.turn('session'),3)
})
