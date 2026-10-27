const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('./connections-browser');
function fixture({ stop = async () => true, connection, busy = false, viewerThrows = false } = {}) {
  const original = connection || { browser_session_facebook: { session_id: 'owned-open' }, facebook_browser_connected_at: 'saved-login', facebook_profile_gen: 4, facebook_profile_state: 'active', facebook_pages: [{ id:'page' }], facebook_groups_member: [{ group_id:'group' }] };
  const conn = structuredClone(original); const calls = []; let held = false;
  const router = createRouter({ authSecret:'secret', requireAuth: () => (req,res,next) => req.user ? next() : res.status(401).json({error:'unauthenticated'}),
    db:{getConnection:async phone=>{assert.equal(phone,'owner');assert.equal(held,true);return structuredClone(conn);},setConnection:async(phone,patch)=>{assert.equal(held,true);Object.assign(conn,patch);calls.push(['save',patch]);}},
    locks:{tryAcquire:(phone,platform)=>{assert.equal(phone,'owner');assert.equal(platform,'facebook');if(busy||held)return null;held=true;return()=>{held=false;};},endLogin:id=>calls.push(['end',id])},
    driver:{stopSession:async id=>{assert.equal(held,true);calls.push(['stop',id]);return stop(id);},deleteProfile:async()=>assert.fail('must preserve profile')},
    viewer:{close:async(key,reason)=>{assert.equal(held,true);calls.push(['viewer',key,reason]);if(viewerThrows)throw Error('viewer transport unavailable');}},lifecycle:{revoke:async()=>assert.fail('must preserve connection')},
  });
  const route=router.stack.find(layer=>layer.route?.path==='/:platform/close')?.route;
  async function invoke(user={userId:'owner'},platform='facebook',body={session_id:'arbitrary-other'}){
    assert.ok(route,'close route exists');const req={params:{platform},body,user};const result={};const res={status(code){result.status=code;return this;},json(value){result.status=result.status||200;result.body=value;return this;}};
    let authenticated=false;route.stack[0].handle(req,res,()=>authenticated=true);if(authenticated)await route.stack[1].handle(req,res,()=>{});return result;
  }
  return {conn,original,calls,invoke,held:()=>held};
}
test('close stops recorded owner session and preserves saved login and profile state',async()=>{const f=fixture();const result=await f.invoke();assert.equal(result.status,200);assert.equal(result.body.state,'stopped');assert.equal(result.body.stopped,true);assert.deepEqual(f.calls.filter(c=>c[0]==='stop'),[['stop','owned-open']]);assert.equal(f.conn.browser_session_facebook,null);for(const key of Object.keys(f.original).filter(k=>k!=='browser_session_facebook'))assert.deepEqual(f.conn[key],f.original[key]);assert.deepEqual(f.calls.find(c=>c[0]==='end'),['end','owned-open']);assert.equal(f.held(),false);});
test('unconfirmed stop retains session and budget for safe retry',async()=>{let stopped=false;const f=fixture({stop:async()=>stopped});const first=await f.invoke();assert.equal(first.status,503);assert.equal(first.body.retry,true);assert.equal(f.conn.browser_session_facebook.session_id,'owned-open');assert.ok(!f.calls.some(c=>c[0]==='end'||c[0]==='save'||c[0]==='viewer'));stopped=true;assert.equal((await f.invoke()).status,200);assert.equal(f.conn.browser_session_facebook,null);});
test('no open session is idempotent and does not revoke saved profile',async()=>{const f=fixture({connection:{facebook_browser_connected_at:'saved',facebook_profile_gen:2}});assert.equal((await f.invoke()).body.state,'stopped');assert.equal((await f.invoke()).body.state,'stopped');assert.equal(f.calls.length,0);assert.equal(f.conn.facebook_browser_connected_at,'saved');});
test('authentication and profile contention prevent remote actions',async()=>{const f=fixture();assert.equal((await f.invoke(null)).status,401);assert.equal(f.calls.length,0);const busy=fixture({busy:true});assert.equal((await busy.invoke()).status,409);assert.equal(busy.calls.length,0);});
test('thrown provider stop remains retryable and releases request lock',async()=>{const f=fixture({stop:async()=>{throw Error('provider unavailable');}});assert.equal((await f.invoke()).status,503);assert.equal(f.conn.browser_session_facebook.session_id,'owned-open');assert.equal(f.held(),false);});

test('confirmed stop succeeds even if viewer cleanup fails',async()=>{const f=fixture({viewerThrows:true});assert.equal((await f.invoke()).status,200);assert.equal(f.conn.browser_session_facebook,null);assert.deepEqual(f.calls.map(c=>c[0]),['stop','save','end','viewer']);assert.equal(f.held(),false);});
