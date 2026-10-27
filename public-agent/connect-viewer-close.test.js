const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(responses) {
 const nodes = new Map(), calls = [], ends = [];
 const node = selector => { if(!nodes.has(selector))nodes.set(selector,{hidden:false,disabled:false,value:'',handlers:{},addEventListener(event,handler){this.handlers[event]=handler;},setSelectionRange(){},focus(){},blur(){}});return nodes.get(selector); };
 const box = {innerHTML:'',querySelector:node};
 const context = {window:{},AbortController,TextDecoder,setTimeout,clearTimeout,fetch:async(url,options={})=>{calls.push({url,options});if(options.method==='POST')return responses.shift();return new Promise(()=>{});}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/connect-viewer.js','utf8'),context);
 return {viewer:context.window.ForlyViewer,box,node,calls,ends,opts:{onEnd:code=>ends.push(code)}};
}
test('login viewer offers Stop and unmounts only after confirmed server stop',async()=>{
 const s=setup([{ok:true,json:async()=>({stopped:true})}]);const handle=s.viewer.mount(s.box,'facebook',s.opts);assert.match(s.box.innerHTML,/data-a="close"/);await handle.close();assert.equal(s.calls[1].url,'/api/connections/browser/facebook/close');assert.equal(s.calls[1].options.method,'POST');assert.deepEqual(s.ends,['closed']);assert.equal(handle.alive,false);assert.equal(s.box.innerHTML,'');
});
test('unconfirmed stop retains viewer and visible retry error, retry can succeed',async()=>{
 const s=setup([{ok:false,json:async()=>({error:'driver_busy'})},{ok:true,json:async()=>({state:'stopped'})},{ok:true,json:async()=>({stopped:true})}]);const handle=s.viewer.mount(s.box,'facebook',s.opts);await handle.close();assert.equal(handle.alive,true);assert.equal(s.node('.cv-close-error').hidden,false);assert.equal(s.node('[data-a="close"]').disabled,false);assert.deepEqual(s.ends,[]);await handle.close();assert.equal(handle.alive,true,'200 alone is not a confirmed stop');await handle.close();assert.equal(handle.alive,false);assert.deepEqual(s.ends,['closed']);
});
test('generic monitors lack Stop unless explicitly configured; hiding is not server stop',async()=>{
 const s=setup([]);const handle=s.viewer.create(s.box,'/api/monitor',s.opts);assert.ok(!s.box.innerHTML.includes('data-a="close"'));await handle.close();handle.unmount();assert.equal(s.calls.filter(call=>call.options.method==='POST').length,0);const configured=s.viewer.create(s.box,'/api/monitor',{closeUrl:'/explicit/close'});assert.match(s.box.innerHTML,/data-a="close"/);configured.unmount();
});
test('Stop intent suppresses SSE termination before and after failed HTTP confirmation',async()=>{
 const nodes=new Map();const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{hidden:false,disabled:false,value:'',addEventListener(){},setSelectionRange(){}});return nodes.get(selector);};
 const box={innerHTML:'',querySelector:node},ends=[];let emit,resolveClose;
 const context={window:{},AbortController,TextDecoder,setTimeout,clearTimeout,fetch:async(url,options={})=>{
  if(options.method==='POST')return new Promise(resolve=>{resolveClose=resolve;});
  return {ok:true,body:{getReader:()=>({read:()=>new Promise(resolve=>{emit=reason=>resolve({done:false,value:new TextEncoder().encode('data: '+JSON.stringify({t:'end',reason})+'\n\n')});})})}};
 }};
 vm.runInNewContext(fs.readFileSync(__dirname+'/connect-viewer.js','utf8'),context);const viewer=context.window.ForlyViewer.mount(box,'facebook',{onEnd:code=>ends.push(code)});await new Promise(resolve=>setImmediate(resolve));
 const closing=viewer.close();emit('session_ended');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(ends,[]);assert.equal(viewer.alive,true);
 resolveClose({ok:false,json:async()=>({error:'driver_busy'})});await closing;assert.deepEqual(ends,[]);assert.equal(node('.cv-close-error').hidden,false);
 emit('closed');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(ends,[],'even SSE closed is not HTTP stop confirmation');
 const retry=viewer.close();resolveClose({ok:true,json:async()=>({stopped:true})});await retry;assert.deepEqual(ends,['closed']);assert.equal(viewer.alive,false);
});
