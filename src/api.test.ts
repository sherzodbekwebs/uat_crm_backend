import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newDb} from 'pg-mem';
import {readFileSync} from 'node:fs';
import {hash} from 'bcryptjs';
import pg from 'pg';
test('Authenticated lead lifecycle, validation, conflict and history',async()=>{
 process.env.JWT_SECRET='test-only-secret-value-with-more-than-32-characters';
 process.env.DATABASE_URL='postgresql://test:test@localhost/test';process.env.PORT='0';
 const db=newDb();db.public.none(readFileSync('sql/001-init.sql','utf8'));
 const adapter=db.adapters.createPg();(pg as any).Pool=adapter.Pool;
 const {pool}=require('./database');
 await pool.query('INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4)',['admin','Admin','admin',await hash('test-password',4)]);
 const {start}=require('./main');const app=await start();const address=app.getHttpServer().address();const base=`http://127.0.0.1:${address.port}/api`;
 let token='';
 async function req(path:string,method='GET',body?:unknown){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
 try {
  assert.equal((await req('/leads')).status,401);
  assert.equal((await req('/auth/login','POST',{username:'admin',password:'bad'})).status,401);
  const auth=await req('/auth/login','POST',{username:'admin',password:'test-password'});assert.equal(auth.status,201);token=auth.data.token;
  const d={fullName:'Test Mijoz',industry:'Logistika',region:'Toshkent shahri',city:'Yashnobod',customerType:'legal',products:[{id:'uat-1',name:'JAC X200'}],paymentType:'leasing',offerSent:'no',phone:'+998901234567',source:'phone',operatorId:1};
  assert.equal((await req('/leads','POST',{...d,products:[]})).status,400);
  assert.equal((await req('/leads','POST',{...d,operatorId:999})).status,400);
  const created=await req('/leads','POST',d);assert.equal(created.status,201);const id=created.data.id;assert.equal(created.data.version,1);
  assert.equal((await req('/leads')).data.length,1);
  const update=await req('/leads/'+id,'PUT',{...d,status:'won',amount:1000000,version:1});assert.equal(update.status,200);assert.equal(update.data.version,2);
  assert.equal((await req('/leads/'+id,'PUT',{...d,status:'contacted',version:1})).status,409);
  assert.equal((await req('/leads/'+id,'PUT',{...d,status:'lost',version:2})).status,400);
  const lost=await req('/leads/'+id,'PUT',{...d,status:'lost',rejectionReason:'expensive',version:2});assert.equal(lost.status,200);
  const events=await req('/leads/'+id+'/events');assert.equal(events.data.length,3);assert.match(events.data[0].description,/won → lost/);
  assert.equal((await req('/leads')).data[0].status,'lost');
 }finally {await app.close();await pool.end();}
});
