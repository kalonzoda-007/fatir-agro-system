// FATIR migration gateway: Cloudflare Worker (staging).
// n8n currently calls AppDeploy for HMAC verification. Do not switch the Telegram bot
// or use production writes before all n8n verifier nodes point at this Worker.
const enc = new TextEncoder();
const txt = (x) => String(x ?? '');
const json = (data, status=200, origin='') => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','vary':'Origin',...(origin?{'access-control-allow-origin':origin}:{})}});
async function hmac(keyBytes, message) {const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(message)));}
const hex = arr=>Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
const eq=(a,b)=>a.length===b.length && a.reduce((v,x,i)=>v|(x^b[i]),0)===0;
const isHex64=s=>/^[a-f0-9]{64}$/i.test(s);
const err=(message,status)=>{const e=new Error(message);e.status=status;throw e};
function allowedOrigin(request,env){const origin=request.headers.get('origin')||'';return origin===env.FRONTEND_ORIGIN?origin:'';}
async function verifyTelegram(initData,token){
 const p=new URLSearchParams(txt(initData));const hash=p.get('hash')||'';const stamp=Number(p.get('auth_date')||0);
 const age=Math.floor(Date.now()/1000)-stamp;
 if(!isHex64(hash)||!stamp||age< -60||age>7200)err('Откройте FATIR через Telegram-бота: сессия истекла или отсутствует.',401);
 p.delete('hash');const canonical=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
 const secret=await hmac(enc.encode('WebAppData'),token);const expected=await hmac(secret,canonical);
 const actual=new Uint8Array(hash.match(/../g).map(v=>parseInt(v,16)));
 if(!eq(expected,actual))err('Подпись Telegram недействительна',401);
 let user;try{user=JSON.parse(p.get('user')||'{}')}catch{err('Некорректные данные Telegram',401)}
 const id=txt(user?.id);if(!/^[0-9]{4,20}$/.test(id))err('Некорректный Telegram ID',401);
 return {id,name:[user.first_name,user.last_name].filter(Boolean).join(' ')};
}
async function signedCall(env,name,payload){
 const endpoint=env['N8N_'+name.toUpperCase()+'_URL'];if(!endpoint)err('Сервис '+name+' не настроен',503);
 const ts=txt(Date.now()),nonce=crypto.randomUUID().replaceAll('-',''),canonical=JSON.stringify(payload);
 const signature=hex(await hmac(enc.encode(env.TELEGRAM_BOT_TOKEN),'FATIR-INTERNAL-V1:'+ts+':'+nonce+':'+canonical));
 const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),25000);
 try{
 const resp=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,_fatir_auth:{ts,nonce,signature},_fatir_canonical:canonical}),signal:ctrl.signal});
 if(!resp.ok)err('n8n '+name+' HTTP '+resp.status,503);
 const result=await resp.json().catch(()=>null);if(!result||typeof result!=='object')err('Некорректный ответ n8n',503);
 return result;
 }finally{clearTimeout(timeout)}
}
async function verifyWorkflow(env,body){
 const p=body?.payload,auth=p?._fatir_auth,canonical=p?._fatir_canonical;
 if(!auth||typeof canonical!=='string'||!isHex64(txt(auth.signature)))err('INVALID_WORKFLOW_SIGNATURE',401);
 const ts=Number(auth.ts),age=Math.abs(Date.now()-ts);
 if(!Number.isFinite(ts)||age>120000||! /^[a-f0-9]{32,64}$/i.test(txt(auth.nonce)))err('EXPIRED_WORKFLOW_SIGNATURE',401);
 const fields={...p};delete fields._fatir_auth;delete fields._fatir_canonical;
 if(JSON.stringify(fields)!==canonical)err('INVALID_WORKFLOW_PAYLOAD',401);
 const expected=hex(await hmac(enc.encode(env.TELEGRAM_BOT_TOKEN),'FATIR-INTERNAL-V1:'+auth.ts+':'+auth.nonce+':'+canonical));
 if(!eq(new Uint8Array(expected.match(/../g).map(x=>parseInt(x,16))),new Uint8Array(auth.signature.match(/../g).map(x=>parseInt(x,16)))))err('INVALID_WORKFLOW_SIGNATURE',401);
 if(!env.FATIR_DB)err('D1 database not bound',503);
 // Atomic uniqueness prevents replay of valid HMACs.
 const found=await env.FATIR_DB.prepare('INSERT INTO workflow_nonces (nonce,created_at) VALUES (?,?) ON CONFLICT(nonce) DO NOTHING').bind(auth.nonce,Date.now()).run();
 if(found.meta.changes!==1)err('WORKFLOW_REPLAY',409);
 return {ok:true,verified:true};
}
export default {async fetch(request,env){
 const url=new URL(request.url),origin=allowedOrigin(request,env);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'vary':'Origin',...(origin?{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, GET, OPTIONS','access-control-allow-headers':'Content-Type'}:{})}});
 if(url.pathname==='/api/health')return json({ok:true,service:'FATIR Cloudflare staging',productionReady:false},200,origin);
 if(request.method!=='POST'||!url.pathname.startsWith('/api/'))return json({error:'Not found'},404,origin);
 // Reject browser origins other than the configured GitHub Pages site, unless this is server-to-server verification.
 if(url.pathname!=='/api/internal-workflow-verify'&&!origin) return json({error:'Origin not allowed'},403);
 try {
 const body=await request.json().catch(()=>err('Некорректный JSON',400));
 if(url.pathname==='/api/internal-workflow-verify')return json(await verifyWorkflow(env,body),200,origin);
 if(!env.TELEGRAM_BOT_TOKEN)err('Секрет Telegram не настроен',503);
 const actor=await verifyTelegram(body.initData,env.TELEGRAM_BOT_TOKEN);
 const catalog=await signedCall(env,'bootstrap',{telegram_id:actor.id});
 if(catalog.ok!==true||txt(catalog.user?.id)!==actor.id)err('Доступ не предоставлен',403);
 if(url.pathname==='/api/bootstrap')return json(catalog,200,origin);
 if(url.pathname==='/api/orders'){
  const requestId=txt(body.requestId);
  if(!/^[a-zA-Z0-9_-]{12,90}$/.test(requestId))err('Неверный идентификатор заявки',400);
  if(!Array.isArray(body.items)||body.items.length<1||body.items.length>50)err('Список товаров недействителен',400);
  const lines=body.items.map(x=>({productCode:txt(x.productCode),quantity:Number(x.quantity),plant:txt(x.plant)}));
  const codes=new Set((catalog.products||[]).map(x=>x.code));
  if(lines.some(x=>!codes.has(x.productCode)||!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>100000||!['PL-AGR','PL-ALN','PL-GLS'].includes(x.plant)))err('Товары или количество недействительны',400);
  const payload={telegram_id:actor.id,request_id:requestId,clientName:txt(body.clientName).slice(0,160),clientId:txt(body.clientId).slice(0,80),region:txt(body.region).slice(0,100),city:txt(body.city).slice(0,120),address:txt(body.address).slice(0,160),deliveryDate:txt(body.deliveryDate).slice(0,30),deliveryType:body.deliveryType==='Доставка'?'Доставка':'Самовывоз',notes:txt(body.notes).slice(0,400),items:lines};
  // Write operations must not start until compatibility with original backend request shape is verified.
  if(env.ENABLE_ORDER_WRITES!=='true')err('Создание заказов временно отключено до проверки миграции',503);
  await signedCall(env,'submit',payload);
  return json({accepted:true,pending:true,requestId,status:'PROCESSING'},200,origin);
 }
 if(url.pathname==='/api/order-status'){
  const requestId=txt(body.requestId);if(!/^[a-zA-Z0-9_-]{12,90}$/.test(requestId))err('Неверный запрос',400);
  let n=2166136261;for(const ch of actor.id+':'+requestId)n=Math.imul(n^ch.charCodeAt(0),16777619)>>>0;
  const source_key=actor.id+':'+((n&2147483647)||123456789);
  const status=await signedCall(env,'status',{telegram_id:actor.id,source_key});
  return json(status,200,origin);
 }
 // Discussions are backed by AppDeploy transactional DB. Do not silently replace with non-atomic Sheets writes.
 if(url.pathname.startsWith('/api/discussions/'))err('Миграция журнала обсуждений требует переноса данных и транзакций D1',503);
 return json({error:'Not found'},404,origin);
 }catch(e){return json({error:e?.message||'Ошибка сервера FATIR'},Number(e?.status)||503,origin)}
}};
