#!/usr/bin/env node
/**
 * KilaCombs Full-Service Backend
 * Wholesale + Personal Training (NYC & Online) + Nutrition + Merch + Workout Plans
 * All orders write to kilacombs_datasheet.xlsx via excel_sync.py
 * Run: node server.js  (default port 3000)
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execFile } = require('child_process');

const PORT      = process.env.PORT || 3000;
const DB_FILE   = path.join(__dirname, 'kilacombs-db.json');
const XLSX_FILE = path.join(__dirname, 'kilacombs_datasheet.xlsx');
const SYNC_PY   = path.join(__dirname, 'excel_sync.py');

// ── Excel sync ────────────────────────────────────────────────────────────────
function excelSync(cmd, data) {
  return new Promise((resolve) => {
    if (!fs.existsSync(XLSX_FILE) || !fs.existsSync(SYNC_PY))
      return resolve({ ok: false, error: 'xlsx or sync not found' });
    const args = data ? [SYNC_PY, cmd, JSON.stringify(data)] : [SYNC_PY, cmd];
    execFile('python3', args, { timeout: 15000 }, (err, stdout) => {
      if (err) { console.error('[Excel]', err.message); return resolve({ ok:false, error:err.message }); }
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ ok:false, error:'parse error' }); }
    });
  });
}

// ── DB ────────────────────────────────────────────────────────────────────────
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  }
  return { orders:[], email_signups:[], training_bookings:[], nutrition_orders:[], merch_orders:[], workout_plan_orders:[], discount_codes:[] };
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function uid(p='') { return p + crypto.randomBytes(8).toString('hex').toUpperCase(); }

let db = loadDB();
['training_bookings','nutrition_orders','merch_orders','workout_plan_orders'].forEach(k=>{ if(!db[k]) db[k]=[]; });

db.discount_codes = [
  {code:'SCHOOL15',   category:'school',  value:15, active:true},
  {code:'YOUTHFUEL',  category:'school',  value:15, active:true},
  {code:'MILITARY20', category:'veteran', value:20, active:true},
  {code:'VETERAN20',  category:'veteran', value:20, active:true},
  {code:'KIDS15',     category:'kids',    value:15, active:true},
  {code:'AFTERSCHOOL',category:'kids',    value:15, active:true},
  {code:'NEWYEAR10',  category:'holiday', value:10, active:true},
  {code:'JULY4TH',    category:'holiday', value:10, active:true},
  {code:'BFCM10',     category:'holiday', value:10, active:true},
  {code:'HOLIDAY10',  category:'holiday', value:10, active:true},
];
saveDB(db);

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};

function json(res, data, status=200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {'Content-Type':'application/json',...CORS});
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body+=c; if(body.length>5e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveFile(res, fp) {
  const types = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  const ct = types[path.extname(fp)] || 'application/octet-stream';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type':ct});
    res.end(data);
  });
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
async function router(req, res) {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const p    = url.pathname;
  const meth = req.method.toUpperCase();

  if (meth==='OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // Health
  if (meth==='GET' && p==='/api/health')
    return json(res, {status:'ok',service:'KilaCombs API',xlsx:fs.existsSync(XLSX_FILE),orders:db.orders.length,training:db.training_bookings.length,timestamp:new Date().toISOString()});

  // Catalogs
  if (meth==='GET' && p==='/api/discounts') {
    const g={}; db.discount_codes.filter(d=>d.active).forEach(d=>{ if(!g[d.category]) g[d.category]=[]; g[d.category].push({code:d.code,value:d.value}); });
    return json(res,{success:true,discounts:g});
  }

  // ── POST /api/orders/full — unified checkout ────────────────────────────────
  if (meth==='POST' && p==='/api/orders/full') {
    const body = await readBody(req);
    const {contact,business,cart,discount,subtotal,discount_amount,total,notes,wholesale,training,nutrition,workout,merch} = body;

    if (!contact?.email || !contact?.name || !contact?.phone)
      return json(res,{success:false,error:'contact.email, name, phone required'},400);
    if (!cart?.length) return json(res,{success:false,error:'Cart is empty'},400);

    const orderId = 'KC-' + uid();
    const now = new Date().toISOString().slice(0,16).replace('T',' ');

    const newOrder = {
      id:orderId, status:'pending_review', created_at:now,
      contact:{name:contact.name,email:contact.email,phone:contact.phone},
      business:business||{}, cart, discount, subtotal, discount_amount, total:total||subtotal,
      notes:notes||'',
      has_wholesale:!!(wholesale?.length), has_training:!!(training?.length),
      has_nutrition:!!(nutrition?.length), has_workout:!!(workout?.length), has_merch:!!(merch?.length),
    };
    db.orders.push(newOrder);
    if (training?.length)  db.training_bookings.push({orderId,contact,items:training,created_at:now});
    if (nutrition?.length) db.nutrition_orders.push({orderId,contact,items:nutrition,created_at:now});
    if (merch?.length)     db.merch_orders.push({orderId,contact,items:merch,created_at:now});
    if (workout?.length)   db.workout_plan_orders.push({orderId,contact,items:workout,created_at:now});
    saveDB(db);

    const cartSummary = cart.map(c=>`${c.name}(${c.qty}x$${c.price})`).join(' | ');
    const noteStr = [notes, training?.length?'Training:'+training.map(t=>t.name).join(','):'', nutrition?.length?'Nutrition:'+nutrition.map(n=>n.name).join(','):'', workout?.length?'Plans:'+workout.map(w=>w.name).join(','):'', merch?.length?'Merch:'+merch.map(m=>m.name).join(','):''].filter(Boolean).join(' | ');

    excelSync('order', {
      id:orderId, date:now, name:contact.name, email:contact.email, phone:contact.phone,
      biz:business?.name||'', biz_type:business?.type||'',
      buyer_type:cart.some(c=>c.type==='wholesale')?'wholesale':'retail',
      city:business?.city||'', state:business?.state||'',
      variant:cart.map(c=>c.type).filter((v,i,a)=>a.indexOf(v)===i).join('+'),
      variant_name:cartSummary.substring(0,80),
      qty:cart.reduce((s,c)=>s+c.qty,0),
      subtotal:subtotal||0, code:discount?.code||'', dpct:discount?.pct||0,
      damt:discount_amount||0, total:total||subtotal||0,
      status:'pending_review', notes:noteStr.substring(0,200)
    }).then(r=>{ if(r.ok) console.log(`[Excel] ${orderId} → row ${r.row}`); else console.warn('[Excel]',r.error); });

    return json(res,{success:true,order_id:orderId,status:'pending_review',message:'Order received! We will contact you within 24 hours.',excel_sync:fs.existsSync(XLSX_FILE)?'queued':'skipped',summary:{items:cart.length,subtotal,discount_amount,total}},201);
  }

  // ── POST /api/orders (legacy wholesale) ─────────────────────────────────────
  if (meth==='POST' && p==='/api/orders') {
    const body = await readBody(req);
    const {contact,business,order,notes,buyer_type} = body;
    if (!contact?.email||!contact?.name||!contact?.phone) return json(res,{success:false,error:'contact required'},400);
    const vmap={original:'Original Honey Blend',ginger:'Ginger Boost',bvitamin:'B-Vitamin Surge'};
    const qty=parseInt(order?.qty)||500;
    const discCode=order?.discount_code?.toUpperCase();
    const disc=db.discount_codes.find(d=>d.code===discCode&&d.active);
    const sub=qty*3; const discAmt=disc?sub*(disc.value/100):0; const tot=sub-discAmt;
    const orderId='KC-WS-'+uid();
    const now=new Date().toISOString().slice(0,16).replace('T',' ');
    db.orders.push({id:orderId,status:'pending_review',created_at:now,contact,business,order:{...order,subtotal:sub,discount_amount:discAmt,total:tot},notes:notes||''});
    saveDB(db);
    excelSync('order',{id:orderId,date:now,name:contact.name,email:contact.email,phone:contact.phone,biz:business?.name||'',biz_type:business?.type||'',buyer_type:buyer_type||'reseller',city:business?.city||'',state:business?.state||'',variant:order?.variant||'original',variant_name:vmap[order?.variant]||'',qty,subtotal:sub,code:discCode||'',dpct:disc?.value||0,damt:discAmt,total:tot,status:'pending_review',notes:notes||''}).then(r=>{ if(r.ok) console.log(`[Excel] WS ${orderId} → row ${r.row}`); });
    return json(res,{success:true,order_id:orderId,message:'Wholesale order received.',summary:{qty:qty+' packs',total:'$'+tot.toFixed(2)}},201);
  }

  // Order lookup
  const om = p.match(/^\/api\/orders\/([A-Z0-9-]+)$/);
  if (meth==='GET' && om) {
    const o=db.orders.find(x=>x.id===om[1]);
    if (!o) return json(res,{success:false,error:'Not found'},404);
    return json(res,{success:true,order:o});
  }

  // Status update
  const sm = p.match(/^\/api\/orders\/([A-Z0-9-]+)\/status$/);
  if (meth==='PATCH' && sm) {
    const {status}=await readBody(req);
    const valid=['pending_review','confirmed','paid','shipped','delivered','cancelled'];
    if (!valid.includes(status)) return json(res,{success:false,error:'Invalid status'},400);
    const o=db.orders.find(x=>x.id===sm[1]);
    if (!o) return json(res,{success:false,error:'Not found'},404);
    o.status=status; o.updated_at=new Date().toISOString(); saveDB(db);
    return json(res,{success:true,order_id:o.id,status});
  }

  // Signups
  if (meth==='POST' && p==='/api/signups') {
    const {email,source,buyer_type}=await readBody(req);
    if (!email?.includes('@')) return json(res,{success:false,error:'Valid email required'},400);
    const norm=email.toLowerCase().trim();
    if (db.email_signups.find(s=>s.email===norm)) return json(res,{success:true,message:'Already on the list!'});
    db.email_signups.push({id:uid('SU-'),email:norm,source:source||'website',buyer_type:buyer_type||'',created_at:new Date().toISOString()});
    saveDB(db);
    excelSync('signup',{email:norm,source:source||'Website',buyer_type:buyer_type||''}).then(r=>{ if(r.ok) console.log(`[Excel] Signup ${norm} → row ${r.row}`); });
    return json(res,{success:true,message:"You're on the list!"},201);
  }

  // Excel stats
  if (meth==='GET' && p==='/api/excel/stats') {
    if (!fs.existsSync(XLSX_FILE)) return json(res,{success:false,error:'Datasheet not found'},404);
    return json(res,{success:true,source:'excel',stats:await excelSync('stats')});
  }

  // Excel download
  if (meth==='GET' && p==='/api/excel/download') {
    if (!fs.existsSync(XLSX_FILE)) return json(res,{success:false,error:'Not found'},404);
    const data=fs.readFileSync(XLSX_FILE);
    res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="KilaCombs_Data_${new Date().toISOString().slice(0,10)}.xlsx"`,'Content-Length':data.length,...CORS});
    return res.end(data);
  }

  // Admin stats
  if (meth==='GET' && p==='/api/admin/stats') {
    const paid=db.orders.filter(o=>['paid','shipped','delivered'].includes(o.status));
    const pending=db.orders.filter(o=>o.status==='pending_review');
    return json(res,{success:true,stats:{total_orders:db.orders.length,pending:pending.length,paid:paid.length,revenue:'$'+paid.reduce((s,o)=>s+(o.total||0),0).toFixed(2),training:db.training_bookings.length,nutrition:db.nutrition_orders.length,merch:db.merch_orders.length,workout:db.workout_plan_orders.length,signups:db.email_signups.length,xlsx:fs.existsSync(XLSX_FILE),recent:db.orders.slice(-8).reverse().map(o=>({id:o.id,status:o.status,name:o.contact?.name,total:'$'+(o.total||0).toFixed(2),date:o.created_at}))}});
  }

  // Static files
  if (meth==='GET') {
    let fp;
    if (p==='/'||p==='/index.html') fp=path.join(__dirname,'public','index.html');
    else if (p==='/shop'||p==='/shop.html') fp=path.join(__dirname,'public','shop.html');
    else fp=path.join(__dirname,'public',p);
    if (fp&&fs.existsSync(fp)) return serveFile(res,fp);
  }

  json(res,{success:false,error:`Not found: ${meth} ${p}`},404);
}

const server = http.createServer(async (req, res) => {
  try { await router(req, res); }
  catch(err) { console.error(err); json(res,{success:false,error:'Internal error'},500); }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   KilaCombs Full-Service API  🍯  NYC                       ║
║   http://localhost:${PORT}                                     ║
╚══════════════════════════════════════════════════════════════╝

  Excel:  ${fs.existsSync(XLSX_FILE)?'✅ Connected':'❌ Not found'}

  POST  /api/orders/full       → Unified checkout → Excel
  POST  /api/orders            → Wholesale legacy → Excel
  POST  /api/signups           → Email list → Excel
  GET   /api/excel/stats       → Live stats from Excel
  GET   /api/excel/download    → Download live xlsx
  GET   /api/admin/stats       → Full admin breakdown
  `);
});
