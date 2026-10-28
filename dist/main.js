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
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const jwt_1 = require("@nestjs/jwt");
const bcryptjs_1 = require("bcryptjs");
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const database_1 = require("./database");
const validation_1 = require("./validation");
// ========================================
// 1. ENVIRONMENT VALIDATION
// ========================================
const isProduction = process.env.NODE_ENV === 'production';
const secret = process.env.JWT_SECRET;
if (!secret ||
    secret.length < 32 ||
    secret.startsWith('replace-')) {
    throw new Error('JWT_SECRET must contain at least 32 random characters');
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
if (isProduction) {
    if (!process.env.FRONTEND_ORIGIN ||
        allowedOrigins.includes('*')) {
        throw new Error('Set explicit FRONTEND_ORIGIN values in production');
    }
    for (const origin of allowedOrigins) {
        if (!origin.startsWith('https://')) {
            throw new Error('Production FRONTEND_ORIGIN must use HTTPS');
        }
    }
}
// ========================================
// 2. VALIDATION HELPERS
// ========================================
function parse(schema, value) {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new common_1.BadRequestException(result.error.issues
            .map((issue) => {
            const path = issue.path.join('.') || 'body';
            return `${path}: ${issue.message}`;
        })
            .join('; '));
    }
    return result.data;
}
const loginSchema = zod_1.z.object({
    username: zod_1.z.string().trim().min(1).max(100),
    password: zod_1.z.string().min(1).max(200),
});
const idSchema = zod_1.z.string().uuid();
const versionSchema = zod_1.z.number().int().positive();
// ========================================
// 4. JWT AUTH GUARD
// ========================================
let AuthGuard = class AuthGuard {
    jwt;
    constructor(jwt) {
        this.jwt = jwt;
    }
    async canActivate(context) {
        const req = context.switchToHttp().getRequest();
        const authorization = req.headers.authorization;
        if (!authorization ||
            !authorization.startsWith('Bearer ')) {
            throw new common_1.UnauthorizedException('Avtorizatsiya talab qilinadi');
        }
        const token = authorization.slice(7).trim();
        if (!token) {
            throw new common_1.UnauthorizedException('Token mavjud emas');
        }
        let claims;
        try {
            claims = await this.jwt.verifyAsync(token);
        }
        catch {
            throw new common_1.UnauthorizedException('Sessiya tugagan. Qayta kiring.');
        }
        if (!Number.isSafeInteger(claims.sub) ||
            claims.sub <= 0) {
            throw new common_1.UnauthorizedException('Token ma’lumotlari noto‘g‘ri');
        }
        // DB errors are not authentication errors.
        const { rows } = await database_1.pool.query('SELECT id, name, role FROM users WHERE id = $1', [claims.sub]);
        if (!rows[0]) {
            throw new common_1.UnauthorizedException('Foydalanuvchi topilmadi');
        }
        req.user = rows[0];
        return true;
    }
};
AuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(jwt_1.JwtService)),
    __metadata("design:paramtypes", [jwt_1.JwtService])
], AuthGuard);
// ========================================
// 5. RESPONSE MAPPER
// ========================================
function mapped(row) {
    return {
        ...row.data,
        id: row.id,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
// ========================================
// 6. API CONTROLLER
// ========================================
let ApiController = class ApiController {
    jwt;
    constructor(jwt) {
        this.jwt = jwt;
    }
    // ----------------------------------------
    // HEALTH CHECK
    // GET /api/health
    // ----------------------------------------
    async health() {
        try {
            await database_1.pool.query('SELECT 1');
            return {
                ok: true,
                service: 'uat-crm-api',
                database: 'connected',
            };
        }
        catch {
            throw new common_1.ServiceUnavailableException('Database connection unavailable');
        }
    }
    // ----------------------------------------
    // LOGIN
    // POST /api/auth/login
    // ----------------------------------------
    async login(body) {
        const data = parse(loginSchema, body);
        const username = data.username.toLowerCase();
        const { rows } = await database_1.pool.query(`SELECT id, name, role, password_hash
       FROM users
       WHERE username = $1`, [username]);
        const user = rows[0];
        if (!user ||
            !(await (0, bcryptjs_1.compare)(data.password, user.password_hash))) {
            throw new common_1.UnauthorizedException('Login yoki parol noto‘g‘ri');
        }
        const token = await this.jwt.signAsync({
            sub: user.id,
        });
        return {
            token,
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
            },
        };
    }
    // ----------------------------------------
    // USERS
    // GET /api/users
    // ----------------------------------------
    async adminUsers(req) {
        if (req.user.role !== 'admin')
            throw new common_1.ForbiddenException('Administrator huquqi talab qilinadi');
        return (await database_1.pool.query('SELECT id, username, name, role FROM users ORDER BY id')).rows;
    }
    async createUser(body, req) {
        if (req.user.role !== 'admin')
            throw new common_1.ForbiddenException('Administrator huquqi talab qilinadi');
        const data = parse(zod_1.z.object({
            username: zod_1.z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,60}$/),
            name: zod_1.z.string().trim().min(2).max(120),
            role: zod_1.z.enum(['admin', 'operator']),
            password: zod_1.z.string().min(12).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must not exceed 72 UTF-8 bytes'),
        }).strict(), body);
        const passwordHash = await (0, bcryptjs_1.hash)(data.password, 12);
        try {
            return (await database_1.pool.query('INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id,username,name,role', [data.username, data.name, data.role, passwordHash])).rows[0];
        }
        catch (error) {
            if (error.code === '23505')
                throw new common_1.ConflictException('Bu login band');
            throw error;
        }
    }
    async updateUser(rawId, body, req) {
        if (req.user.role !== 'admin')
            throw new common_1.ForbiddenException('Administrator huquqi talab qilinadi');
        const id = parse(zod_1.z.coerce.number().int().positive(), rawId);
        const data = parse(zod_1.z.object({ name: zod_1.z.string().trim().min(2).max(120), role: zod_1.z.enum(['admin', 'operator']), password: zod_1.z.string().min(12).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must not exceed 72 UTF-8 bytes').optional() }).strict(), body);
        if (id === req.user.id && data.role !== 'admin')
            throw new common_1.BadRequestException('O‘z administrator huquqingizni olib tashlay olmaysiz');
        const passwordHash = data.password ? await (0, bcryptjs_1.hash)(data.password, 12) : null;
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(8241002)');
            const actor = (await client.query('SELECT role FROM users WHERE id=$1', [req.user.id])).rows[0];
            if (actor?.role !== 'admin')
                throw new common_1.ForbiddenException('Administrator huquqi talab qilinadi');
            const result = await client.query('UPDATE users SET name=$1,role=$2,password_hash=COALESCE($3,password_hash) WHERE id=$4 RETURNING id,username,name,role', [data.name, data.role, passwordHash, id]);
            if (!result.rowCount)
                throw new common_1.NotFoundException('Foydalanuvchi topilmadi');
            await client.query('COMMIT');
            return result.rows[0];
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async catalog() {
        try {
            const response = await fetch(process.env.PRODUCTS_API_URL || 'https://api.uzautotrailer.uz/products', { signal: AbortSignal.timeout(15000) });
            if (!response.ok)
                throw new Error('Catalog unavailable');
            const rows = await response.json();
            if (!Array.isArray(rows))
                throw new Error('Invalid catalog');
            return rows.filter((p) => p.isActive !== false);
        }
        catch {
            throw new common_1.ServiceUnavailableException('Katalogni yuklab bo‘lmadi');
        }
    }
    async users() {
        const { rows } = await database_1.pool.query(`SELECT id, name, role
       FROM users
       ORDER BY id`);
        return rows;
    }
    // ----------------------------------------
    // PRODUCTS
    // GET /api/products
    // ----------------------------------------
    async products() {
        const productsUrl = process.env.PRODUCTS_API_URL ||
            'https://api.uzautotrailer.uz/products';
        try {
            const response = await fetch(productsUrl, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
                signal: AbortSignal.timeout(12000),
            });
            if (!response.ok) {
                throw new Error(`Products API returned ${response.status}`);
            }
            const json = await response.json();
            const result = (0, validation_1.normalizeProducts)(json);
            if (!result.length) {
                throw new Error('Products API returned no products');
            }
            return result;
        }
        catch (error) {
            console.error('Products API error:', error);
            throw new common_1.ServiceUnavailableException('Mahsulot API’siga ulanib bo‘lmadi. Qayta urinib ko‘ring.');
        }
    }
    // ----------------------------------------
    // LEADS LIST
    // GET /api/leads
    // ----------------------------------------
    async leads() {
        const { rows } = await database_1.pool.query(`SELECT *
       FROM leads
       ORDER BY created_at DESC`);
        return rows.map(mapped);
    }
    // ----------------------------------------
    // LEAD HISTORY
    // GET /api/leads/:id/events
    // ----------------------------------------
    async events(rawId) {
        const id = parse(idSchema, rawId);
        const { rows } = await database_1.pool.query(`SELECT
         e.id,
         e.description,
         e.created_at AS "createdAt",
         u.name AS actor
       FROM lead_events e
       JOIN users u ON u.id = e.actor_id
       WHERE e.lead_id = $1
       ORDER BY e.id DESC`, [id]);
        return rows;
    }
    // ----------------------------------------
    // CREATE LEAD
    // POST /api/leads
    // ----------------------------------------
    async create(body, req) {
        return this.save(body, req.user.id);
    }
    // ----------------------------------------
    // UPDATE LEAD
    // PUT /api/leads/:id
    // ----------------------------------------
    async update(rawId, body, req) {
        const id = parse(idSchema, rawId);
        const payload = parse(zod_1.z.object({
            version: versionSchema,
        }).passthrough(), body);
        const { version, ...data } = payload;
        return this.save(data, req.user.id, id, version);
    }
    // ----------------------------------------
    // SAVE LEAD
    // PostgreSQL transaction
    // ----------------------------------------
    async save(body, actor, id, version) {
        const data = parse(validation_1.leadSchema, body);
        const client = await database_1.pool.connect();
        let transactionStarted = false;
        try {
            await client.query('BEGIN');
            transactionStarted = true;
            // Verify operator.
            const operator = await client.query('SELECT id FROM users WHERE id = $1', [data.operatorId]);
            if (!operator.rowCount) {
                throw new common_1.BadRequestException('Operator topilmadi');
            }
            let result;
            let description = 'Lead yaratildi';
            if (id) {
                // Lock existing lead.
                const existing = await client.query(`SELECT *
           FROM leads
           WHERE id = $1
           FOR UPDATE`, [id]);
                const old = existing.rows[0];
                if (!old) {
                    throw new common_1.NotFoundException('Lead topilmadi');
                }
                // Optimistic concurrency control.
                if (old.version !== version) {
                    throw new common_1.ConflictException('Lead boshqa operator tomonidan yangilandi. ' +
                        'Oynani yopib, yangilangan kartani oching.');
                }
                description =
                    old.data.status !== data.status
                        ? `Status: ${old.data.status} → ${data.status}`
                        : 'Lead ma’lumotlari yangilandi';
                result = await client.query(`UPDATE leads
           SET
             data = $1,
             version = version + 1,
             updated_at = NOW()
           WHERE id = $2
           RETURNING *`, [data, id]);
            }
            else {
                id = (0, node_crypto_1.randomUUID)();
                result = await client.query(`INSERT INTO leads (
             id,
             data,
             created_by
           )
           VALUES ($1, $2, $3)
           RETURNING *`, [id, data, actor]);
            }
            // Add activity history.
            await client.query(`INSERT INTO lead_events (
           lead_id,
           actor_id,
           description
         )
         VALUES ($1, $2, $3)`, [id, actor, description]);
            await client.query('COMMIT');
            transactionStarted = false;
            return mapped(result.rows[0]);
        }
        catch (error) {
            if (transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (rollbackError) {
                    console.error('Transaction rollback failed:', rollbackError);
                }
            }
            if (error instanceof common_1.HttpException) {
                throw error;
            }
            console.error('Lead save error:', error);
            throw new common_1.InternalServerErrorException('Lead saqlashda server xatosi yuz berdi');
        }
        finally {
            client.release();
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
    (0, common_1.Get)('admin/users'),
    (0, common_1.UseGuards)(AuthGuard),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "adminUsers", null);
__decorate([
    (0, common_1.Post)('admin/users'),
    (0, common_1.UseGuards)(AuthGuard),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "createUser", null);
__decorate([
    (0, common_1.Put)('admin/users/:id'),
    (0, common_1.UseGuards)(AuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "updateUser", null);
__decorate([
    (0, common_1.Get)('catalog'),
    (0, common_1.UseGuards)(AuthGuard),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ApiController.prototype, "catalog", null);
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
// ========================================
// 7. APP MODULE
// ========================================
let AppModule = class AppModule {
};
AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            jwt_1.JwtModule.register({
                secret,
                signOptions: {
                    expiresIn: '8h',
                    algorithm: 'HS256',
                },
            }),
        ],
        controllers: [ApiController],
        providers: [AuthGuard],
    })
], AppModule);
// ========================================
// 8. START APPLICATION
// ========================================
async function start() {
    const app = await core_1.NestFactory.create(AppModule, {
        rawBody: false,
    });
    // Hide NestJS fingerprinting header.
    app.getHttpAdapter()
        .getInstance()
        .disable('x-powered-by');
    // Security headers.
    app.use((0, helmet_1.default)());
    // Trust only the explicitly configured proxy hops.
    // Configure this only after checking the hosting setup.
    const proxyHops = Number(process.env.TRUST_PROXY_HOPS || '0');
    if (!Number.isInteger(proxyHops) ||
        proxyHops < 0) {
        throw new Error('Invalid TRUST_PROXY_HOPS');
    }
    if (proxyHops > 0) {
        app.getHttpAdapter()
            .getInstance()
            .set('trust proxy', proxyHops);
    }
    // Rate limit login attempts.
    app.use('/api/auth/login', (0, express_rate_limit_1.default)({
        windowMs: 15 * 60 * 1000,
        limit: 15,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
            statusCode: 429,
            message: 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring.',
        },
    }));
    // Cross-origin access.
    app.enableCors({
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
        ],
        credentials: false,
    });
    app.enableShutdownHooks();
    // Verify database before starting.
    try {
        await database_1.pool.query('SELECT 1');
        console.log('PostgreSQL connected successfully');
    }
    catch (error) {
        console.error('PostgreSQL connection failed:', error);
        throw error;
    }
    const port = Number(process.env.PORT || 3001);
    if (!Number.isInteger(port) ||
        (port < 1 && !(process.env.NODE_ENV === 'test' && port === 0)) ||
        port > 65535) {
        throw new Error('Invalid PORT');
    }
    await app.listen(port, '0.0.0.0');
    console.log(`CRM API started on port ${port}`);
    return app;
}
// ========================================
// 9. DIRECT EXECUTION
// ========================================
if (require.main === module) {
    start().catch((error) => {
        console.error('Application startup failed:', error);
        process.exitCode = 1;
    });
}
