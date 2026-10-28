
import 'reflect-metadata';
import 'dotenv/config';

import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Req,
  UseGuards,
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  InternalServerErrorException,
  Inject,
  HttpException,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { pool } from './database';
import { leadSchema, normalizeProducts } from './validation';

// ========================================
// 1. ENVIRONMENT VALIDATION
// ========================================

const isProduction = process.env.NODE_ENV === 'production';

const secret = process.env.JWT_SECRET;

if (
  !secret ||
  secret.length < 32 ||
  secret.startsWith('replace-')
) {
  throw new Error(
    'JWT_SECRET must contain at least 32 random characters',
  );
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
)
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (isProduction) {
  if (
    !process.env.FRONTEND_ORIGIN ||
    allowedOrigins.includes('*')
  ) {
    throw new Error(
      'Set explicit FRONTEND_ORIGIN values in production',
    );
  }

  for (const origin of allowedOrigins) {
    if (!origin.startsWith('https://')) {
      throw new Error(
        'Production FRONTEND_ORIGIN must use HTTPS',
      );
    }
  }
}

// ========================================
// 2. VALIDATION HELPERS
// ========================================

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new BadRequestException(
      result.error.issues
        .map((issue) => {
          const path = issue.path.join('.') || 'body';
          return `${path}: ${issue.message}`;
        })
        .join('; '),
    );
  }

  return result.data;
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

const idSchema = z.string().uuid();

const versionSchema = z.number().int().positive();

// ========================================
// 3. TYPES
// ========================================

interface AuthUser {
  id: number;
  name: string;
  role: string;
}

interface AuthRequest {
  headers: {
    authorization?: string;
  };
  user: AuthUser;
}

// ========================================
// 4. JWT AUTH GUARD
// ========================================

@Injectable()
class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService)
    private readonly jwt: JwtService,
  ) {}

  async canActivate(
    context: ExecutionContext,
  ): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();

    const authorization = req.headers.authorization;

    if (
      !authorization ||
      !authorization.startsWith('Bearer ')
    ) {
      throw new UnauthorizedException(
        'Avtorizatsiya talab qilinadi',
      );
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      throw new UnauthorizedException(
        'Token mavjud emas',
      );
    }

    let claims: { sub: number };

    try {
      claims = await this.jwt.verifyAsync<{
        sub: number;
      }>(token);
    } catch {
      throw new UnauthorizedException(
        'Sessiya tugagan. Qayta kiring.',
      );
    }

    if (
      !Number.isSafeInteger(claims.sub) ||
      claims.sub <= 0
    ) {
      throw new UnauthorizedException(
        'Token ma’lumotlari noto‘g‘ri',
      );
    }

    // DB errors are not authentication errors.
    const { rows } = await pool.query(
      'SELECT id, name, role FROM users WHERE id = $1',
      [claims.sub],
    );

    if (!rows[0]) {
      throw new UnauthorizedException(
        'Foydalanuvchi topilmadi',
      );
    }

    req.user = rows[0];

    return true;
  }
}

// ========================================
// 5. RESPONSE MAPPER
// ========================================

function mapped(row: any) {
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

@Controller('api')
class ApiController {
  constructor(
    @Inject(JwtService)
    private readonly jwt: JwtService,
  ) {}

  // ----------------------------------------
  // HEALTH CHECK
  // GET /api/health
  // ----------------------------------------

  @Get('health')
  async health() {
    try {
      await pool.query('SELECT 1');

      return {
        ok: true,
        service: 'uat-crm-api',
        database: 'connected',
      };
    } catch {
      throw new ServiceUnavailableException(
        'Database connection unavailable',
      );
    }
  }

  // ----------------------------------------
  // LOGIN
  // POST /api/auth/login
  // ----------------------------------------

  @Post('auth/login')
  async login(@Body() body: unknown) {
    const data = parse(loginSchema, body);

    const username = data.username.toLowerCase();

    const { rows } = await pool.query(
      `SELECT id, name, role, password_hash
       FROM users
       WHERE username = $1`,
      [username],
    );

    const user = rows[0];

    if (
      !user ||
      !(await compare(data.password, user.password_hash))
    ) {
      throw new UnauthorizedException(
        'Login yoki parol noto‘g‘ri',
      );
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

  @Get('admin/users')
  @UseGuards(AuthGuard)
  async adminUsers(@Req() req: AuthRequest) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Administrator huquqi talab qilinadi');
    return (await pool.query('SELECT id, username, name, role FROM users ORDER BY id')).rows;
  }

  @Post('admin/users')
  @UseGuards(AuthGuard)
  async createUser(@Body() body: unknown, @Req() req: AuthRequest) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Administrator huquqi talab qilinadi');
    const data = parse(z.object({
      username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,60}$/),
      name: z.string().trim().min(2).max(120),
      role: z.enum(['admin', 'operator']),
      password: z.string().min(12).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must not exceed 72 UTF-8 bytes'),
    }).strict(), body);
    const passwordHash = await hash(data.password, 12);
    try {
      return (await pool.query('INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id,username,name,role', [data.username,data.name,data.role,passwordHash])).rows[0];
    } catch (error: any) {
      if (error.code === '23505') throw new ConflictException('Bu login band');
      throw error;
    }
  }

  @Put('admin/users/:id')
  @UseGuards(AuthGuard)
  async updateUser(@Param('id') rawId: string, @Body() body: unknown, @Req() req: AuthRequest) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Administrator huquqi talab qilinadi');
    const id = parse(z.coerce.number().int().positive(), rawId);
    const data = parse(z.object({ name:z.string().trim().min(2).max(120), role:z.enum(['admin','operator']), password:z.string().min(12).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must not exceed 72 UTF-8 bytes').optional() }).strict(),body);
    if (id === req.user.id && data.role !== 'admin') throw new BadRequestException('O‘z administrator huquqingizni olib tashlay olmaysiz');
    const passwordHash = data.password ? await hash(data.password,12) : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(8241002)');
      const actor = (await client.query('SELECT role FROM users WHERE id=$1',[req.user.id])).rows[0];
      if (actor?.role !== 'admin') throw new ForbiddenException('Administrator huquqi talab qilinadi');
      const result = await client.query('UPDATE users SET name=$1,role=$2,password_hash=COALESCE($3,password_hash) WHERE id=$4 RETURNING id,username,name,role',[data.name,data.role,passwordHash,id]);
      if (!result.rowCount) throw new NotFoundException('Foydalanuvchi topilmadi');
      await client.query('COMMIT');
      return result.rows[0];
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  @Get('catalog')
  @UseGuards(AuthGuard)
  async catalog() {
    try {
      const response = await fetch(process.env.PRODUCTS_API_URL || 'https://api.uzautotrailer.uz/products', {signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('Catalog unavailable');
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Invalid catalog');
      return rows.filter((p: any) => p.isActive !== false);
    } catch { throw new ServiceUnavailableException('Katalogni yuklab bo‘lmadi'); }
  }

  @Get('users')
  @UseGuards(AuthGuard)
  async users() {
    const { rows } = await pool.query(
      `SELECT id, name, role
       FROM users
       ORDER BY id`,
    );

    return rows;
  }

  // ----------------------------------------
  // PRODUCTS
  // GET /api/products
  // ----------------------------------------

  @Get('products')
  @UseGuards(AuthGuard)
  async products() {
    const productsUrl =
      process.env.PRODUCTS_API_URL ||
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
        throw new Error(
          `Products API returned ${response.status}`,
        );
      }

      const json = await response.json();

      const result = normalizeProducts(json);

      if (!result.length) {
        throw new Error('Products API returned no products');
      }

      return result;
    } catch (error) {
      console.error('Products API error:', error);

      throw new ServiceUnavailableException(
        'Mahsulot API’siga ulanib bo‘lmadi. Qayta urinib ko‘ring.',
      );
    }
  }

  // ----------------------------------------
  // LEADS LIST
  // GET /api/leads
  // ----------------------------------------

  @Get('leads')
  @UseGuards(AuthGuard)
  async leads() {
    const { rows } = await pool.query(
      `SELECT *
       FROM leads
       ORDER BY created_at DESC`,
    );

    return rows.map(mapped);
  }

  // ----------------------------------------
  // LEAD HISTORY
  // GET /api/leads/:id/events
  // ----------------------------------------

  @Get('leads/:id/events')
  @UseGuards(AuthGuard)
  async events(@Param('id') rawId: string) {
    const id = parse(idSchema, rawId);

    const { rows } = await pool.query(
      `SELECT
         e.id,
         e.description,
         e.created_at AS "createdAt",
         u.name AS actor
       FROM lead_events e
       JOIN users u ON u.id = e.actor_id
       WHERE e.lead_id = $1
       ORDER BY e.id DESC`,
      [id],
    );

    return rows;
  }

  // ----------------------------------------
  // CREATE LEAD
  // POST /api/leads
  // ----------------------------------------

  @Post('leads')
  @UseGuards(AuthGuard)
  async create(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    return this.save(body, req.user.id);
  }

  // ----------------------------------------
  // UPDATE LEAD
  // PUT /api/leads/:id
  // ----------------------------------------

  @Put('leads/:id')
  @UseGuards(AuthGuard)
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    const id = parse(idSchema, rawId);

    const payload = parse(
      z.object({
        version: versionSchema,
      }).passthrough(),
      body,
    );

    const { version, ...data } = payload;

    return this.save(
      data,
      req.user.id,
      id,
      version,
    );
  }

  // ----------------------------------------
  // SAVE LEAD
  // PostgreSQL transaction
  // ----------------------------------------

  private async save(
    body: unknown,
    actor: number,
    id?: string,
    version?: number,
  ) {
    const data = parse(leadSchema, body);

    const client = await pool.connect();

    let transactionStarted = false;

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      // Verify operator.
      const operator = await client.query(
        'SELECT id FROM users WHERE id = $1',
        [data.operatorId],
      );

      if (!operator.rowCount) {
        throw new BadRequestException(
          'Operator topilmadi',
        );
      }

      let result;
      let description = 'Lead yaratildi';

      if (id) {
        // Lock existing lead.
        const existing = await client.query(
          `SELECT *
           FROM leads
           WHERE id = $1
           FOR UPDATE`,
          [id],
        );

        const old = existing.rows[0];

        if (!old) {
          throw new NotFoundException(
            'Lead topilmadi',
          );
        }

        // Optimistic concurrency control.
        if (old.version !== version) {
          throw new ConflictException(
            'Lead boshqa operator tomonidan yangilandi. ' +
            'Oynani yopib, yangilangan kartani oching.',
          );
        }

        description =
          old.data.status !== data.status
            ? `Status: ${old.data.status} → ${data.status}`
            : 'Lead ma’lumotlari yangilandi';

        result = await client.query(
          `UPDATE leads
           SET
             data = $1,
             version = version + 1,
             updated_at = NOW()
           WHERE id = $2
           RETURNING *`,
          [data, id],
        );
      } else {
        id = randomUUID();

        result = await client.query(
          `INSERT INTO leads (
             id,
             data,
             created_by
           )
           VALUES ($1, $2, $3)
           RETURNING *`,
          [id, data, actor],
        );
      }

      // Add activity history.
      await client.query(
        `INSERT INTO lead_events (
           lead_id,
           actor_id,
           description
         )
         VALUES ($1, $2, $3)`,
        [id, actor, description],
      );

      await client.query('COMMIT');
      transactionStarted = false;

      return mapped(result.rows[0]);
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error(
            'Transaction rollback failed:',
            rollbackError,
          );
        }
      }

      if (error instanceof HttpException) {
        throw error;
      }

      console.error('Lead save error:', error);

      throw new InternalServerErrorException(
        'Lead saqlashda server xatosi yuz berdi',
      );
    } finally {
      client.release();
    }
  }
}

// ========================================
// 7. APP MODULE
// ========================================

@Module({
  imports: [
    JwtModule.register({
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
class AppModule {}

// ========================================
// 8. START APPLICATION
// ========================================

export async function start() {
  const app = await NestFactory.create(AppModule, {
    rawBody: false,
  });

  // Hide NestJS fingerprinting header.
  app.getHttpAdapter()
    .getInstance()
    .disable('x-powered-by');

  // Security headers.
  app.use(helmet());

  // Trust only the explicitly configured proxy hops.
  // Configure this only after checking the hosting setup.
  const proxyHops = Number(
    process.env.TRUST_PROXY_HOPS || '0',
  );

  if (
    !Number.isInteger(proxyHops) ||
    proxyHops < 0
  ) {
    throw new Error('Invalid TRUST_PROXY_HOPS');
  }

  if (proxyHops > 0) {
    app.getHttpAdapter()
      .getInstance()
      .set('trust proxy', proxyHops);
  }

  // Rate limit login attempts.
  app.use(
    '/api/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 15,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        statusCode: 429,
        message:
          'Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring.',
      },
    }),
  );

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
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected successfully');
  } catch (error) {
    console.error('PostgreSQL connection failed:', error);
    throw error;
  }

  const port = Number(process.env.PORT || 3001);

  if (
    !Number.isInteger(port) ||
    (port < 1 && !(process.env.NODE_ENV === 'test' && port === 0)) ||
    port > 65535
  ) {
    throw new Error('Invalid PORT');
  }

  await app.listen(port, '0.0.0.0');

  console.log(
    `CRM API started on port ${port}`,
  );

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
