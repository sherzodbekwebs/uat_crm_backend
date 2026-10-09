"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.start = start;
require("reflect-metadata");
require("dotenv/config");
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const bcryptjs_1 = require("bcryptjs");
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const database_1 = require("./database");
const validation_1 = require("./validation");
function parse(schema, v) { const r = schema.safeParse(v); if (!r.success)
    throw new common_1.BadRequestException(r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')); return r.data; }
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32 || secret.startsWith('replace-'))
    throw new Error('Set a random JWT_SECRET of at least 32 characters');
if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is required');
let AuthGuard = class AuthGuard {
    jwt;
    constructor(jwt) {
        this.jwt = jwt;
    }
    async canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        try {
            const token = req.headers.authorization?.split(' ');
            if (token?.[0] !== 'Bearer')
                throw Error();
            const claim = await this.jwt.verifyAsync(token[1]);
            const { rows } = await database_1.pool.query('SELECT id,name,role FROM users WHERE id=$1', [claim.sub]);
            if (!rows[0])
                throw Error();
            req.user = rows[0];
            return true;
        }
        catch {
            throw new common_1.UnauthorizedException('Sessiya tugagan. Qayta kiring.');
        }
    }
};
AuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(jwt_1.JwtService)),
    __metadata("design:paramtypes", [jwt_1.JwtService])
], AuthGuard);
function mapped(r) { return { ...r.data, id: r.id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at }; }
let ApiController = class ApiController {
    jwt;
    constructor(jwt) {
        this.jwt = jwt;
    }
    async health() { await database_1.pool.query('SELECT 1'); return { ok: true }; }
    async login(body) {
        const d = parse(zod_1.z.object({ username: zod_1.z.string().min(1).max(100), password: zod_1.z.string().min(1).max(200) }), body);
        const { rows } = await database_1.pool.query('SELECT * FROM users WHERE username=$1', [d.username.toLowerCase()]);
        const u = rows[0];
        if (!u || !await (0, bcryptjs_1.compare)(d.password, u.password_hash))
            throw new common_1.UnauthorizedException('Login yoki parol noto‘g‘ri');
        return { token: await this.jwt.signAsync({ sub: u.id }), user: { id: u.id, name: u.name, role: u.role } };
    }
    async users() { return (await database_1.pool.query('SELECT id,name,role FROM users ORDER BY id')).rows; }
    async products() {
        try {
            const r = await fetch(process.env.PRODUCTS_API_URL || 'https://api.uzautotrailer.uz/products', { signal: AbortSignal.timeout(12000) });
            if (!r.ok)
                throw Error();
            const result = (0, validation_1.normalizeProducts)(await r.json());
            if (!result.length)
                throw Error();
            return result;
        }
        catch {
            throw new common_1.ServiceUnavailableException('Mahsulot API’siga ulanib bo‘lmadi yoki javob formati mos emas. Qayta urinib ko‘ring.');
        }
    }
    async leads() { return (await database_1.pool.query('SELECT * FROM leads ORDER BY created_at DESC')).rows.map(mapped); }
    async events(id) { parse(zod_1.z.string().uuid(), id); return (await database_1.pool.query('SELECT e.id,e.description,e.created_at AS "createdAt",u.name AS actor FROM lead_events e JOIN users u ON u.id=e.actor_id WHERE lead_id=$1 ORDER BY e.id DESC', [id])).rows; }
    async create(body, req) { return this.save(body, req.user.id); }
    async update(id, body, req) { parse(zod_1.z.string().uuid(), id); const version = parse(zod_1.z.number().int().positive(), body?.version); const { version: _, ...data } = body; return this.save(data, req.user.id, id, version); }
    async save(body, actor, id, version) {
        const d = parse(validation_1.leadSchema, body);
        const c = await database_1.pool.connect();
        try {
            await c.query('BEGIN');
            if (!(await c.query('SELECT id FROM users WHERE id=$1', [d.operatorId])).rowCount)
                throw new common_1.BadRequestException('Operator topilmadi');
            let result;
            let description = 'Lead yaratildi';
            if (id) {
                const old = (await c.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE', [id])).rows[0];
                if (!old)
                    throw new common_1.NotFoundException();
                if (old.version !== version)
                    throw new common_1.ConflictException('Lead boshqa operator tomonidan yangilandi. Oynani yopib, yangilangan kartani oching.');
                description = old.data.status !== d.status ? `Status: ${old.data.status} → ${d.status}` : 'Lead ma’lumotlari yangilandi';
                result = await c.query('UPDATE leads SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *', [d, id]);
            }
            else {
                id = (0, node_crypto_1.randomUUID)();
                result = await c.query('INSERT INTO leads(id,data,created_by) VALUES($1,$2,$3) RETURNING *', [id, d, actor]);
            }
            await c.query('INSERT INTO lead_events(lead_id,actor_id,description) VALUES($1,$2,$3)', [id, actor, description]);
            await c.query('COMMIT');
            return mapped(result.rows[0]);
        }
        catch (e) {
            await c.query('ROLLBACK');
            throw e;
        }
        finally {
            c.release();
        }
    }
};
__decorate([
    (0, common_1.Get)('health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "health", null);
__decorate([
    (0, common_1.Post)('auth/login'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "login", null);
__decorate([
    (0, common_1.Get)('users'),
    (0, common_1.UseGuards)(AuthGuard),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "users", null);
__decorate([
    (0, common_1.Get)('products'),
    (0, common_1.UseGuards)(AuthGuard),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "products", null);
__decorate([
    (0, common_1.Get)('leads'),
    (0, common_1.UseGuards)(AuthGuard),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "leads", null);
__decorate([
    (0, common_1.Get)('leads/:id/events'),
    (0, common_1.UseGuards)(AuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "events", null);
__decorate([
    (0, common_1.Post)('leads'),
    (0, common_1.UseGuards)(AuthGuard),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "create", null);
__decorate([
    (0, common_1.Put)('leads/:id'),
    (0, common_1.UseGuards)(AuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "update", null);
ApiController = __decorate([
    (0, common_1.Controller)('api'),
    __param(0, (0, common_1.Inject)(jwt_1.JwtService)),
    __metadata("design:paramtypes", [jwt_1.JwtService])
], ApiController);
let AppModule = class AppModule {
};
AppModule = __decorate([
    (0, common_1.Module)({ imports: [jwt_1.JwtModule.register({ secret, signOptions: { expiresIn: '8h' } })], controllers: [ApiController], providers: [AuthGuard] })
], AppModule);
async function start() {
    const app = await core_1.NestFactory.create(AppModule);
    app.use((0, helmet_1.default)());
    app.use('/api/auth/login', (0, express_rate_limit_1.default)({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
    app.enableCors({ origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim()) });
    app.enableShutdownHooks();
    await database_1.pool.query('SELECT 1');
    await app.listen(process.env.PORT || 3000, '0.0.0.0');
    return app;
}
if (require.main === module)
    start().catch(e => { console.error(e.message); process.exit(1); });
