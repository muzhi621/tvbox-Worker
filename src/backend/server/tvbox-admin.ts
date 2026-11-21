import { Hono } from "hono"
import { getDb } from "../internal/model/db"
import {
  accessDenied,
  envValue,
  hmac,
  readSources,
  saveSources,
  type TvboxSource,
} from "./tvbox-store"

/**
 * TVBox 源管理页与配套 API。
 *
 * 设计边界：
 *  - 管理端点强制要求 TVBOX_ACCESS_CODE（未配置时返回 503），避免暴露。
 *  - 只读取 db.storages 的 mount_path / driver / remark 供选择，绝不返回
 *    addition（其中含网盘 Token / 分享链接等凭据）。
 *  - 订阅链接中的 sources 签名由服务端用 JWT_SECRET 签发，客户端拿不到 secret。
 */

export const tvboxAdminRouter = new Hono()

tvboxAdminRouter.use("*", async (c, next) => {
  const denied = accessDenied(c, true)
  if (denied) return denied
  await next()
})

function absoluteUrl(c: any, path: string): string {
  const origin = new URL(c.req.url).origin
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`
}

type MountOption = { path: string; driver: string; remark: string }

export async function readMounts(c: any): Promise<MountOption[]> {
  try {
    const db = await getDb(c.env)
    return (db.storages || [])
      .filter((s: any) => s && !s.disabled && s.mount_path)
      .map((s: any) => ({
        path: String(s.mount_path),
        driver: String(s.driver || ""),
        remark: String(s.remark || ""),
      }))
      .sort((a: MountOption, b: MountOption) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

function sanitizeSources(input: any): TvboxSource[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: TvboxSource[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue
    const id = String(raw.id || "").trim()
    const name = String(raw.name || "").trim()
    const path = String(raw.path || "").trim()
    if (!validId(id) || seen.has(id) || !name || !path) continue
    if (!path.startsWith("/") || path.includes("..") || path.includes("\0")) continue
    seen.add(id)
    out.push({ id, name: name.slice(0, 80), path, password: String(raw.password || "").slice(0, 200) })
    if (out.length >= 100) break
  }
  return out
}

tvboxAdminRouter.get("/manage/data", async (c) => {
  const sources = await readSources(c)
  const mounts = await readMounts(c)
  return c.json({
    code: 200,
    data: {
      sources,
      mounts,
      envFallback: (await readSources(c)).length === 0,
    },
  })
})

tvboxAdminRouter.post("/manage/save", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const sources = sanitizeSources(body?.sources)
  await saveSources(c, sources)
  return c.json({ code: 200, message: `saved ${sources.length} source(s)`, data: { sources } })
})

tvboxAdminRouter.post("/manage/link", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const wanted = Array.isArray(body?.sources)
    ? body.sources.map((x: any) => String(x)).filter((x: string) => validId(x))
    : []
  const sources = await readSources(c)
  const ids = wanted.filter((id: string) => sources.some((s) => s.id === id))
  const requested = ids.join(",")
  const sig = requested ? await hmac(c, requested) : ""

  const code = envValue(c, "TVBOX_ACCESS_CODE")
  const params: string[] = []
  if (code) params.push(`code=${encodeURIComponent(code)}`)
  if (requested && sig) {
    params.push(`sources=${encodeURIComponent(requested)}`)
    params.push(`sig=${encodeURIComponent(sig)}`)
  }
  const base = absoluteUrl(c, "/@tvbox/config.json")
  const url = params.length ? `${base}?${params.join("&")}` : base
  return c.json({ code: 200, data: { url, count: ids.length } })
})

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TVBox 源管理</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:24px;max-width:920px;margin:0 auto;background:Canvas;color:CanvasText;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
h2{font-size:15px;font-weight:600;margin:24px 0 10px}
.muted{opacity:.65;font-size:13px}
.card{border:1px solid CanvasText;border-radius:10px;padding:14px;margin:10px 0;opacity:.9}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1;min-width:180px}
input,select,button{font:inherit;padding:7px 10px;border:1px solid CanvasText;border-radius:6px;background:Canvas;color:CanvasText}
input[type=checkbox]{width:16px;height:16px}
button{cursor:pointer}
button.primary{background:CanvasText;color:Canvas}
button.danger{color:#c0392b;border-color:#c0392b}
.code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all;background:CanvasText;color:Canvas;padding:10px;border-radius:6px}
.msg{padding:9px 12px;border-radius:6px;margin:10px 0;display:none}
.msg.ok{display:block;background:#e6f4ea;color:#1e7e34}
.msg.err{display:block;background:#fdecea;color:#c0392b}
.empty{padding:18px;text-align:center;opacity:.6;border:1px dashed CanvasText;border-radius:10px}
.hint{font-size:12px;opacity:.7;margin-top:6px}
</style>
</head>
<body>
<h1>TVBox 源管理</h1>
<div class="muted">从已挂载的网盘目录中选择资源，勾选后生成订阅链接。网盘凭据不会出现在本页面。</div>
<div id="msg" class="msg"></div>

<h2>1. 当前源</h2>
<div id="sourceList"></div>

<h2>2. 添加源</h2>
<div class="card">
<div class="row">
<select id="mountSelect" class="grow"></select>
<input id="sourceName" class="grow" placeholder="显示名称（可选）">
<button id="addBtn" class="primary">添加</button>
</div>
<div class="hint">下拉列表来自 OpenList 已挂载的网盘。若为空，请先在 OpenList 后台「存储」页面挂载网盘或分享。</div>
</div>

<h2>3. 选择源并生成订阅链接</h2>
<div id="pickList"></div>
<div class="row" style="margin-top:12px">
<button id="genBtn" class="primary">生成订阅链接</button>
<span class="muted" id="pickCount"></span>
</div>
<div id="linkBox" style="display:none;margin-top:12px">
<div class="code" id="linkText"></div>
<div class="row" style="margin-top:8px"><button id="copyBtn">复制链接</button></div>
</div>

<script>
var code=new URLSearchParams(location.search).get('code')||'';
var sources=[],mounts=[];
function q(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(path,opt){return fetch(path+(path.indexOf('?')<0?'?':'&')+'code='+encodeURIComponent(code),opt).then(function(r){return r.json().then(function(j){if(!r.ok||(j.code&&j.code!==200))throw new Error(j.message||'请求失败');return j})})}
function show(text,ok){var el=document.getElementById('msg');el.textContent=text;el.className='msg '+(ok?'ok':'err')}
function render(){
var list=document.getElementById('sourceList');
if(!sources.length){list.innerHTML='<div class="empty">还没有源，请先在下方添加</div>'}
else{list.innerHTML=sources.map(function(s){return '<div class="card row"><div class="grow"><strong>'+q(s.name)+'</strong><div class="muted">'+q(s.path)+' · id: '+q(s.id)+'</div></div><button class="danger" data-del="'+q(s.id)+'">删除</button></div>'}).join('')}
Array.prototype.forEach.call(document.querySelectorAll('[data-del]'),function(b){b.onclick=function(){remove(b.getAttribute('data-del'))}});

var sel=document.getElementById('mountSelect');
var current=sel.value;
sel.innerHTML=mounts.length?mounts.map(function(m){return '<option value="'+q(m.path)+'">'+q(m.path)+(m.remark?' — '+q(m.remark):'')+'</option>'}).join(''):'<option value="">（无可用挂载）</option>';
if(current&&Array.prototype.some.call(sel.options,function(o){return o.value===current}))sel.value=current;

var pick=document.getElementById('pickList');
if(!sources.length){pick.innerHTML='<div class="empty">暂无可选源</div>'}
else{pick.innerHTML=sources.map(function(s){return '<label class="card row"><input type="checkbox" checked data-pick="'+q(s.id)+'"><span class="grow">'+q(s.name)+'</span><span class="muted">'+q(s.path)+'</span></label>'}).join('')}
updateCount();
}
function updateCount(){var n=Array.prototype.filter.call(document.querySelectorAll('[data-pick]'),function(x){return x.checked}).length;document.getElementById('pickCount').textContent='已选 '+n+' 个'}
function load(){return api('/@tvbox/manage/data').then(function(j){sources=j.data.sources||[];mounts=j.data.mounts||[];render();if(j.data.envFallback)show('当前使用环境变量配置；保存一次后改用数据库存储',true)}).catch(function(e){show(e.message,false)})}
function save(list){return api('/@tvbox/manage/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sources:list})}).then(function(){sources=list;render();show('已保存，订阅即时生效',true)}).catch(function(e){show(e.message,false)})}
function remove(id){save(sources.filter(function(s){return s.id!==id}))}
document.getElementById('addBtn').onclick=function(){
var path=document.getElementById('mountSelect').value;
var name=document.getElementById('sourceName').value.trim();
if(!path){show('请先挂载网盘',false);return}
var base=path.replace(/^\/+|\/+$/g,'').split('/').pop()||'source';
var id=base.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,32);
var n=1;while(sources.some(function(s){return s.id===id})){id=base.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,28)+'_'+(n++)}
save(sources.concat([{id:id,name:name||base,path:path}]));document.getElementById('sourceName').value='';
};
document.getElementById('pickList').onchange=updateCount;
document.getElementById('genBtn').onclick=function(){
var ids=Array.prototype.filter.call(document.querySelectorAll('[data-pick]'),function(x){return x.checked}).map(function(x){return x.getAttribute('data-pick')});
if(!ids.length){show('请至少选择一个源',false);return}
api('/@tvbox/manage/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sources:ids})}).then(function(j){
document.getElementById('linkText').textContent=j.data.url;document.getElementById('linkBox').style.display='block';show('链接已生成，可导入 TVBox',true)
}).catch(function(e){show(e.message,false)});
};
document.getElementById('copyBtn').onclick=function(){var t=document.getElementById('linkText').textContent;if(navigator.clipboard)navigator.clipboard.writeText(t).then(function(){show('已复制',true)});else show('请手动复制',false)};
Array.prototype.forEach.call(document.querySelectorAll('[data-pick]'),function(x){x.onchange=updateCount});
load();
</script>
</body>
</html>`

tvboxAdminRouter.get("/admin", (c) => c.html(ADMIN_HTML))
