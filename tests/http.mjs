import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const child=spawn(process.execPath,['main.ts'],{cwd:root,env:{...process.env,MAKEFUN_ENV_URL:'',MAKEFUN_SHOP_TOKEN:'test-bearer'}});
child.stderr.pipe(process.stderr);
const port=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;const m=/listening on port (\d+)/.exec(text);if(m)resolve(Number(m[1]));});child.once('exit',c=>reject(new Error('startup '+c)));});
const origin=`http://127.0.0.1:${port}`;
async function request(method,path,body,authenticated=true,headers={}) {
  const response=await fetch(origin+path,{method,headers:{...(authenticated?{authorization:'Bearer test-bearer'}:{}),'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();
  return {status:response.status,body:text?JSON.parse(text):null,headers:response.headers};
}
async function raw(text) {
  return await new Promise((resolve,reject)=>{
    const socket=connect(port,'127.0.0.1'); let out='';
    socket.setTimeout(5000,()=>socket.destroy(new Error('raw timeout')));
    socket.on('connect',()=>socket.write(text));socket.on('data',b=>out+=b.toString());socket.on('end',()=>resolve(out));socket.on('error',reject);
  });
}
try {
  assert.equal((await request('POST','/api/v3/user/repos',{name:'cache-test'})).status,201);
  const prefix='/api/v3/repos/adaiversen/cache-test';
  const issue=await request('POST',prefix+'/issues',{title:'before',body:'雪❄'});
  assert.equal(issue.status,201);
  const path=prefix+'/issues/'+issue.body.number;
  const first=await request('GET',path);
  for(let i=0;i<3;i++)assert.deepEqual((await request('GET',path)).body,first.body);
  assert.equal((await request('GET',path,undefined,false)).status,401);
  const alternate=await raw(`GET ${path} HTTP/1.1\r\nHost: different.example\r\nAuthorization: Bearer test-bearer\r\nConnection: close\r\n\r\n`);
  assert.equal(JSON.parse(alternate.split('\r\n\r\n')[1]).url.startsWith('http://different.example/'),true);
  assert.equal((await request('GET',path)).body.url.startsWith(origin),true);
  assert.equal((await request('PATCH',path,{title:'after'})).status,200);
  assert.equal((await request('GET',path)).body.title,'after');
  assert.equal((await request('HEAD',path)).body,null);
  assert.equal((await request('GET',prefix+'/issues?state=closed')).body.length,0);
  assert.equal((await request('GET',prefix+'/issues?state=open')).body.length,1);
  const gql=await request('POST','/api/graphql',{query:`mutation { updateIssue(input:{id:"${first.body.node_id}",title:"graphql"}) { issue { title } } }`});
  assert.equal(gql.body.errors,undefined,JSON.stringify(gql.body));
  assert.equal((await request('GET',path)).body.title,'graphql');
  await request('GET',prefix+'/issues');
  const mcp=await request('POST','/mcp',{jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'create_issue',arguments:{owner:'adaiversen',repo:'cache-test',title:'mcp'}}});
  assert.equal(mcp.body.error,undefined);assert.notEqual(mcp.body.result?.isError,true);
  assert.equal((await request('GET',prefix+'/issues')).body.length,2);
  const pipeline=await raw('GET /healthz HTTP/1.1\r\nHost: local\r\n\r\nGET /healthz HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n');
  assert.equal(pipeline.split('HTTP/1.1 200').length-1,2);
  const chunk=await raw('POST /api/v3/user/repos HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer test-bearer\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n16\r\n{"name":"chunk-test"}\n\r\n0\r\n\r\n');
  assert.match(chunk,/HTTP\/1.1 201/);
  const long=await raw('GET /healthz HTTP/1.1\r\nX-Long: '+'x'.repeat(65536)+'\r\n\r\n');
  assert.match(long,/HTTP\/1.1 431/);
  await request('DELETE',prefix);
  assert.equal((await request('GET',path)).status,404);
  await request('POST','/api/v3/user/repos',{name:'cache-test'});
  assert.equal((await request('GET',path)).status,404);
  console.log('HTTP/cache integration: auth, origins, mutation invalidation, GraphQL, MCP, HEAD, pagination, UTF-8, pipelining, chunked bodies, header cap, delete/recreate passed');
} finally {child.kill('SIGTERM');}
