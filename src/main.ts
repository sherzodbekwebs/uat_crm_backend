import 'reflect-metadata';
import 'dotenv/config';
import {NestFactory} from '@nestjs/core';
import {Module,Controller,Get,Post,Put,Body,Param,Req,UseGuards,Injectable,CanActivate,ExecutionContext,UnauthorizedException,BadRequestException,ConflictException,NotFoundException,ServiceUnavailableException,Inject} from '@nestjs/common';
import {JwtModule,JwtService} from '@nestjs/jwt';
import {compare} from 'bcryptjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool} from './database';
import {leadSchema,normalizeProducts} from './validation';
function parse<T>(schema:z.ZodType<T>,v:unknown):T {const r=schema.safeParse(v);if(!r.success)throw new BadRequestException(r.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '));return r.data;}
const secret=process.env.JWT_SECRET;
if(!secret||secret.length<32||secret.startsWith('replace-'))throw new Error('Set a random JWT_SECRET of at least 32 characters');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
@Injectable()
class AuthGuard implements CanActivate {
 constructor(@Inject(JwtService) private jwt:JwtService){}
 async canActivate(ctx:ExecutionContext) {
  const req=ctx.switchToHttp().getRequest();
  try {const token=req.headers.authorization?.split(' ');if(token?.[0]!=='Bearer')throw Error(); const claim=await this.jwt.verifyAsync(token[1]);const {rows}=await pool.query('SELECT id,name,role FROM users WHERE id=$1',[claim.sub]);if(!rows[0])throw Error();req.user=rows[0];return true;} catch {throw new UnauthorizedException('Sessiya tugagan. Qayta kiring.');}
 }
}
function mapped(r:any){return {...r.data,id:r.id,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at};}
@Controller('api')
class ApiController {
 constructor(@Inject(JwtService) private jwt:JwtService){}
 @Get('health') async health(){await pool.query('SELECT 1');return {ok:true};}
 @Post('auth/login') async login(@Body() body:unknown){
  const d=parse(z.object({username:z.string().min(1).max(100),password:z.string().min(1).max(200)}),body);
  const {rows}=await pool.query('SELECT * FROM users WHERE username=$1',[d.username.toLowerCase()]);const u=rows[0];
  if(!u||!await compare(d.password,u.password_hash))throw new UnauthorizedException('Login yoki parol noto‘g‘ri');
  return {token:await this.jwt.signAsync({sub:u.id}),user:{id:u.id,name:u.name,role:u.role}};
 }
 @Get('users') @UseGuards(AuthGuard) async users(){return (await pool.query('SELECT id,name,role FROM users ORDER BY id')).rows;}
 @Get('products') @UseGuards(AuthGuard) async products(){
  try {const r=await fetch(process.env.PRODUCTS_API_URL||'https://api.uzautotrailer.uz/products',{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error();const result=normalizeProducts(await r.json());if(!result.length)throw Error();return result;}catch {throw new ServiceUnavailableException('Mahsulot API’siga ulanib bo‘lmadi yoki javob formati mos emas. Qayta urinib ko‘ring.');}
 }
 @Get('leads') @UseGuards(AuthGuard) async leads(){return (await pool.query('SELECT * FROM leads ORDER BY created_at DESC')).rows.map(mapped);}
 @Get('leads/:id/events') @UseGuards(AuthGuard) async events(@Param('id') id:string){parse(z.string().uuid(),id);return (await pool.query('SELECT e.id,e.description,e.created_at AS "createdAt",u.name AS actor FROM lead_events e JOIN users u ON u.id=e.actor_id WHERE lead_id=$1 ORDER BY e.id DESC',[id])).rows;}
 @Post('leads') @UseGuards(AuthGuard) async create(@Body() body:unknown,@Req() req:any){return this.save(body,req.user.id);}
 @Put('leads/:id') @UseGuards(AuthGuard) async update(@Param('id') id:string,@Body() body:any,@Req() req:any){parse(z.string().uuid(),id);const version=parse(z.number().int().positive(),body?.version);const {version:_,...data}=body;return this.save(data,req.user.id,id,version);}
 async save(body:unknown,actor:number,id?:string,version?:number){
  const d=parse(leadSchema,body);const c=await pool.connect();
  try {
   await c.query('BEGIN');
   if(!(await c.query('SELECT id FROM users WHERE id=$1',[d.operatorId])).rowCount)throw new BadRequestException('Operator topilmadi');
   let result;let description='Lead yaratildi';
   if(id){const old=(await c.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old)throw new NotFoundException();if(old.version!==version)throw new ConflictException('Lead boshqa operator tomonidan yangilandi. Oynani yopib, yangilangan kartani oching.');
    description=old.data.status!==d.status?`Status: ${old.data.status} → ${d.status}`:'Lead ma’lumotlari yangilandi';
    result=await c.query('UPDATE leads SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *',[d,id]);
   }else {id=randomUUID();result=await c.query('INSERT INTO leads(id,data,created_by) VALUES($1,$2,$3) RETURNING *',[id,d,actor]);}
   await c.query('INSERT INTO lead_events(lead_id,actor_id,description) VALUES($1,$2,$3)',[id,actor,description]);
   await c.query('COMMIT');return mapped(result.rows[0]);
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
}
@Module({imports:[JwtModule.register({secret,signOptions:{expiresIn:'8h'}})],controllers:[ApiController],providers:[AuthGuard]})
class AppModule {}
export async function start(){
 const app=await NestFactory.create(AppModule);
 app.use(helmet());
 app.use('/api/auth/login',rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false}));
 app.enableCors({origin:(process.env.FRONTEND_ORIGIN||'http://localhost:5173').split(',').map(s=>s.trim())});
 app.enableShutdownHooks();await pool.query('SELECT 1');await app.listen(process.env.PORT||3000,'0.0.0.0');return app;
}
if(require.main===module)start().catch(e=>{console.error(e.message);process.exit(1)});
