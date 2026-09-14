/* Regression: Classic uses the data-injected renderer, including default pages. */
const assert = require('node:assert/strict');
const path = require('node:path');
const db = require('./db');
const businessCache = require('./business-cache');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const routeFile = path.join(__dirname, 'routes/pages.js');
const routeRequire = createRequire(routeFile);
const routeModule = {exports:{}};
// Capture route handlers without installing Express or opening a socket.
const express = {text: () => (_req, _res, next) => next(), Router() {
  const router = {stack:[]};
  for (const method of ['get','post']) router[method] = (routePath,...handlers) =>
    router.stack.push({route:{path:routePath,stack:handlers.map(handle=>({handle}))}});
  return router;
}};
vm.runInNewContext(fs.readFileSync(routeFile,'utf8'), {
  require: name => name === 'express' ? express : name === '../distribution/jobs' ? {liveDeps:()=>({})} : routeRequire(name),
  module:routeModule, __dirname:path.dirname(routeFile), process, console, Buffer, URLSearchParams
}, {filename:routeFile});
const createRouter = routeModule.exports;

async function main() {
  const originalGet = db.getPage, originalBusiness = businessCache.get;
  let page;
  db.getPage = async () => page;
  businessCache.get = async () => null;
  try {
    const router = createRouter({
      templatesDir: path.join(__dirname, '../public-nadlan/templates'),
      pageBaseUrl: 'https://example.test', baseUrl: 'https://example.test',
      requireAuth: () => (_req, _res, next) => next(),
      normalizeAuthPhone: value => value, adminPhones: [], authSecret: 'test'
    });
    const route = router.stack.find(layer => layer.route && layer.route.path === '/p/:id');
    const render = () => new Promise((resolve, reject) => {
      const res = { set() { return this; }, type() { return this; },
        send(html) { resolve({html}); }, sendFile(file) { resolve({file}); } };
      Promise.resolve(route.route.stack.at(-1).handle({params:{id:'fixture'},query:{}}, res)).catch(reject);
    });
    for (const theme of [{template:'original'}, undefined]) {
      page = {status:'active', theme, property:{title:'A </script> home'}, hero:{video_url:'/test.mp4'}, agent:{name:'Agent'}};
      const result = await render();
      assert.match(result.html, /\/tpl\/original\.js/);
      assert.match(result.html, /window\.__PAGE__=/);
      assert.match(result.html, /\\u003c\/script>/, 'injected payload escapes HTML');
      assert.match(result.html, /data-lead-form/);
      assert.doesNotMatch(result.html, /assets\/tour\.mp4|דיזנגוף 156|8,400,000/);
    }
    page = {status:'expired',theme:{template:'original'}};
    assert.match((await render()).file, /public-nadlan\/p\/index\.html$/);
    page = null;
    assert.ok((await render()).file, 'missing pages keep the not-found shell');
    console.log('classic-template.test.js ok');
  } finally { db.getPage = originalGet; businessCache.get = originalBusiness; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
