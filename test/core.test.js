import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createBridge, boundedFetch, UPSTREAM, MAX_OUTPUT, MAX_INPUT } from '../src/core.js';
const credential = () => randomBytes(32).toString('hex'); // only ephemeral synthetic data
const listName = 'pkulaw_list_upstream_tools';
const callName = 'pkulaw_call_upstream_tool';

test('startup and list_tools need no credentials and never connect', async () => {
  let calls = 0;
  const bridge = createBridge({ connect: () => calls++ });
  assert.equal(bridge.listTools().tools.length, 2);
  const result = await bridge.callTool(listName);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PKULAW_TOKEN_REQUIRED/);
  assert.equal(calls, 0);
});
test('invalid token and header injection are refused', async () => {
  for (const token of ['', 'a\r\nb', 'a b']) {
    const result = await createBridge({ token, connect: () => assert.fail() }).callTool(listName);
    assert.equal(result.isError, true);
  }
});
test('no arbitrary URL, headers or unknown wrapper accepted; size limited', async () => {
  const bridge = createBridge({ token: credential(), connect: () => assert.fail() });
  for (const [name, args] of [[listName, { url: 'https://example.org' }], [listName, { headers: {} }], ['unknown', {}], [callName, {name:'x',arguments:[],}], [callName, {name:'x',arguments:{x:'a'.repeat(MAX_INPUT)}}]]) {
    assert.equal((await bridge.callTool(name,args)).isError, true);
  }
});
test('mock list pagination and call work; closes each fresh session', async () => {
  const token = credential(); let closed = 0;
  const bridge = createBridge({ token, connect: async (actual, signal) => {
    assert.equal(actual,token); assert.equal(signal.aborted,false);
    return { listTools: async p => ({tools:[{name:'mock_only',inputSchema:{type:'object'}}], nextCursor:p.cursor}), callTool: async p => ({content:[{type:'text',text:JSON.stringify(p)}]}), close:async()=>closed++ };
  }});
  assert.match((await bridge.callTool(listName,{cursor:'page'})).content[0].text,/mock_only/);
  assert.match((await bridge.callTool(callName,{name:'mock_only',arguments:{q:'law'}})).content[0].text,/law/);
  assert.equal(closed,2);
});
test('upstream exception, error result and success echo do not leak credential', async () => {
  const token=credential();
  for (const mode of ['exception','error','echo']) {
    const bridge=createBridge({token,connect:async()=>({callTool:async()=>{
      if(mode==='exception') throw new Error(token);
      return {isError:mode==='error',content:[{type:'text',text:token}]};
    },close:async()=>{throw new Error(token);}})});
    const serialized=JSON.stringify(await bridge.callTool(callName,{name:'mock_only',arguments:{}}));
    assert.equal(serialized.includes(token),false);
  }
});
test('oversized mock result is rejected', async()=>{
  const bridge=createBridge({token:credential(),connect:async()=>({listTools:async()=>({data:'a'.repeat(MAX_OUTPUT+1)}),close:async()=>{}})});
  assert.match(JSON.stringify(await bridge.callTool(listName)),/TOO_LARGE/);
});
test('concurrent separate bridge instances never share credentials or sessions', async()=>{
  const a=credential(), b=credential(); const seen=[];
  const connect=async token=>({listTools:async()=>{await new Promise(r=>setTimeout(r,5));seen.push(token);return {tools:[]};},close:async()=>{}});
  await Promise.all([createBridge({token:a,connect}).callTool(listName),createBridge({token:b,connect}).callTool(listName)]);
  assert.deepEqual(new Set(seen),new Set([a,b]));
});
test('fetch pins endpoint, disables redirects, strips caller auth/cookies and applies signal',async()=>{
  const token=credential(), signal=new AbortController().signal;
  const f=boundedFetch(token,signal,async(url,opts)=>{
    assert.equal(url,UPSTREAM); assert.equal(opts.redirect,'error'); assert.equal(opts.credentials,'omit');
    assert.equal(opts.headers.get('authorization'),`Bearer ${token}`);
    assert.equal(opts.headers.has('cookie'),false); assert.equal(opts.headers.has('x-forwarded-for'),false);
    assert.equal(opts.signal,signal); return new Response('{}');
  });
  await assert.rejects(f('https://example.org',{}),/NOT_ALLOWED/);
  await assert.rejects(f(UPSTREAM+'?token=anything',{}),/NOT_ALLOWED/);
  assert.equal(await(await f(UPSTREAM,{method:'POST',headers:{authorization:'discard',cookie:'discard','x-forwarded-for':'discard'},body:'{}'})).text(),'{}');
});
test('fetch discards HTTP error body and caps streamed response',async()=>{
  const token=credential(), signal=new AbortController().signal;
  await assert.rejects(boundedFetch(token,signal,async()=>new Response(token,{status:401}))(UPSTREAM),e=>!e.message.includes(token));
  const response=await boundedFetch(token,signal,async()=>new Response('a'.repeat(MAX_OUTPUT+1)))(UPSTREAM);
  await assert.rejects(response.text(),/TOO_LARGE/);
});
test('GET 405 remains SDK-compatible and sensitive error body is discarded',async()=>{
  const token=credential();
  const response=await boundedFetch(token,new AbortController().signal,async()=>new Response(token,{status:405}))(UPSTREAM,{method:'GET'});
  assert.equal(response.status,405); assert.equal(await response.text(),'');
});
test('operation abort reaches pending fetch and fails closed',async()=>{
  const controller=new AbortController();
  const f=boundedFetch(credential(),controller.signal,async(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  }));
  const pending=f(UPSTREAM,{method:'POST',body:'{}'});
  controller.abort();
  await assert.rejects(pending,/aborted/);
});
