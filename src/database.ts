import 'dotenv/config';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from 'bcryptjs';
export const pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:undefined});
async function run() {
 if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
 if(process.argv[2]==='migrate') {
  const client=await pool.connect();
  try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(8241001)'); await client.query(readFileSync(resolve(__dirname,'../sql/001-init.sql'),'utf8')); await client.query('COMMIT'); } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  console.log('Database migration complete');
 } else if(process.argv[2]==='seed') {
  const users=[['admin','Admin','admin','ADMIN_PASSWORD'],['rahima','Rahima','operator','RAHIMA_PASSWORD'],['amirshoh','Amirshoh','operator','AMIRSHOH_PASSWORD']];
  for (const [, , ,key] of users) if((process.env[key]||'').length<10) throw new Error(`${key} must contain at least 10 characters`);
  for(const [username,name,role,key] of users) await pool.query('INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING',[username,name,role,await hash(process.env[key]!,12)]);
  console.log('Accounts created (existing passwords preserved)');
 }
 await pool.end();
}
if(require.main===module) run().catch(e=>{console.error(e.message);process.exit(1)});
