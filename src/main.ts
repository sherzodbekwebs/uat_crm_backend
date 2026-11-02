
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
  Query,
  Req,
  Res,
  HttpCode,
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
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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


const INSTAGRAM_SINGLETON_ID = 1;
const INSTAGRAM_24_HOURS_MS = 24 * 60 * 60 * 1000;

function instagramIsConfigured() {
  const key = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY || '';
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET &&
    process.env.INSTAGRAM_REDIRECT_URI && process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN &&
    /^[a-f0-9]{64}$/i.test(key));
}

function instagramConfig() {
  if (!instagramIsConfigured()) throw new ServiceUnavailableException('Instagram sozlamalari serverda to‘liq kiritilmagan');
  const apiVersion = process.env.INSTAGRAM_GRAPH_API_VERSION || 'v26.0';
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new ServiceUnavailableException('Instagram Graph API versiyasi noto‘g‘ri');
  return {
    appId: process.env.INSTAGRAM_APP_ID!.trim(),
    appSecret: process.env.INSTAGRAM_APP_SECRET!.trim(),
    redirectUri: process.env.INSTAGRAM_REDIRECT_URI!.trim(),
    verifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN!.trim(),
    encryptionKey: Buffer.from(process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY!, 'hex'),
    apiVersion,
  };
}

function constantTimeTextEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encryptInstagramToken(token: string) {
  const key = instagramConfig().encryptionKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptInstagramToken(value: string) {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new ServiceUnavailableException('Instagram token format noto‘g‘ri');
  try {
    const decipher = createDecipheriv('aes-256-gcm', instagramConfig().encryptionKey, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new ServiceUnavailableException('Instagram tokenini ochib bo‘lmadi. Encryption key sozlamasini tekshiring.');
  }
}

async function instagramFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const message = typeof data?.error?.message === 'string' ? data.error.message : 'Instagram API so‘rovi bajarilmadi';
    throw new Error(message.slice(0, 300));
  }
  return data;
}

async function instagramAccount() {
  const result = await pool.query(
    'SELECT id, ig_user_id, username, access_token_encrypted, token_expires_at, webhook_subscribed, connected_at FROM instagram_accounts WHERE id = $1',
    [INSTAGRAM_SINGLETON_ID],
  );
  return result.rows[0] || null;
}

async function instagramAccessToken(account: any) {
  let token = decryptInstagramToken(account.access_token_encrypted);
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (expiresAt && expiresAt <= Date.now()) throw new ServiceUnavailableException('Instagram sessiyasi tugagan. Akkauntni qayta ulang.');
  if (expiresAt && expiresAt - Date.now() < 10 * 24 * 60 * 60 * 1000) {
    try {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', token);
      const refreshed: any = await instagramFetch(url.toString());
      if (typeof refreshed.access_token === 'string') {
        token = refreshed.access_token;
        const seconds = Number(refreshed.expires_in) || 5184000;
        await pool.query(
          'UPDATE instagram_accounts SET access_token_encrypted = $1, token_expires_at = $2 WHERE id = $3',
          [encryptInstagramToken(token), new Date(Date.now() + seconds * 1000), INSTAGRAM_SINGLETON_ID],
        );
      }
    } catch {
      throw new ServiceUnavailableException('Instagram tokenini yangilab bo‘lmadi. Akkauntni qayta ulang.');
    }
  }
  return token;
}

function instagramFrontendRedirect(result: string, webhook: string) {
  const origin = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
  const url = new URL('/', origin);
  url.searchParams.set('instagram', result);
  if (webhook) url.searchParams.set('webhook', webhook);
  return url.toString();
}

async function persistInstagramWebhookEvent(entry: any, event: any) {
  const accountId = String(entry?.id || '');
  const message = event?.message;
  if (!accountId || !message || message.is_deleted || message.is_unsent) return;
  const account = await pool.query('SELECT ig_user_id FROM instagram_accounts WHERE id = $1 AND ig_user_id = $2', [INSTAGRAM_SINGLETON_ID, accountId]);
  if (!account.rowCount) return;

  const senderId = String(event?.sender?.id || '');
  const recipientId = String(event?.recipient?.id || '');
  const echo = Boolean(message.is_echo) || senderId === accountId;
  const customerId = echo ? recipientId : senderId;
  if (!customerId || customerId === accountId) return;

  const direction = echo ? 'outbound' : 'inbound';
  const timestamp = Number(event.timestamp) || Date.now();
  const sentAt = new Date(timestamp);
  const text = typeof message.text === 'string' ? message.text.slice(0, 5000) : '';
  const attachments = (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 10).map((item: any) => ({
    type: typeof item?.type === 'string' ? item.type.slice(0, 40) : 'file',
    url: typeof item?.payload?.url === 'string' && item.payload.url.startsWith('https://') ? item.payload.url.slice(0, 2000) : null,
  }));
  const fallback = attachments.length ? '[' + attachments.map((item: any) => item.type).join(', ') + ']' : '';
  const lastText = text || fallback;
  const externalId = String(message.mid || message.id || createHash('sha256').update([accountId, customerId, direction, timestamp, text].join(':')).digest('hex'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversation = await client.query(
      'INSERT INTO instagram_conversations (ig_user_id, sender_id, sender_username, last_message_text, last_message_at, last_inbound_at) ' +
      'VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 = \'inbound\' THEN $5 ELSE NULL END) ' +
      'ON CONFLICT (ig_user_id, sender_id) DO UPDATE SET ' +
      'sender_username = COALESCE(NULLIF(EXCLUDED.sender_username, \'\'), instagram_conversations.sender_username), ' +
      'last_message_text = EXCLUDED.last_message_text, ' +
      'last_message_at = GREATEST(instagram_conversations.last_message_at, EXCLUDED.last_message_at), ' +
      'last_inbound_at = CASE WHEN $6 = \'inbound\' THEN GREATEST(COALESCE(instagram_conversations.last_inbound_at, EXCLUDED.last_inbound_at), EXCLUDED.last_inbound_at) ELSE instagram_conversations.last_inbound_at END, ' +
      'updated_at = NOW() RETURNING id',
      [accountId, customerId, echo ? '' : String(event?.sender?.username || '').slice(0, 100), lastText, sentAt, direction],
    );
    const inserted = await client.query(
      'INSERT INTO instagram_messages (conversation_id, external_message_id, direction, message_text, attachments, sent_at) ' +
      'VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (external_message_id) DO NOTHING RETURNING id',
      [conversation.rows[0].id, externalId, direction, text, JSON.stringify(attachments), sentAt],
    );
    if (inserted.rowCount && direction === 'inbound') {
      await client.query('UPDATE instagram_conversations SET unread_count = unread_count + 1 WHERE id = $1', [conversation.rows[0].id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function persistInstagramWebhook(body: any) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const event of events) await persistInstagramWebhookEvent(entry, event);
  }
}


const INSTAGRAM_SINGLETON_ID = 1;
const INSTAGRAM_24_HOURS_MS = 24 * 60 * 60 * 1000;

function instagramIsConfigured() {
  const key = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY || '';
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET &&
    process.env.INSTAGRAM_REDIRECT_URI && process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN &&
    /^[a-f0-9]{64}$/i.test(key));
}

function instagramConfig() {
  if (!instagramIsConfigured()) throw new ServiceUnavailableException('Instagram sozlamalari serverda to‘liq kiritilmagan');
  const apiVersion = process.env.INSTAGRAM_GRAPH_API_VERSION || 'v26.0';
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new ServiceUnavailableException('Instagram Graph API versiyasi noto‘g‘ri');
  return {
    appId: process.env.INSTAGRAM_APP_ID!.trim(),
    appSecret: process.env.INSTAGRAM_APP_SECRET!.trim(),
    redirectUri: process.env.INSTAGRAM_REDIRECT_URI!.trim(),
    verifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN!.trim(),
    encryptionKey: Buffer.from(process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY!, 'hex'),
    apiVersion,
  };
}

function constantTimeTextEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encryptInstagramToken(token: string) {
  const key = instagramConfig().encryptionKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptInstagramToken(value: string) {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new ServiceUnavailableException('Instagram token format noto‘g‘ri');
  try {
    const decipher = createDecipheriv('aes-256-gcm', instagramConfig().encryptionKey, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new ServiceUnavailableException('Instagram tokenini ochib bo‘lmadi. Encryption key sozlamasini tekshiring.');
  }
}

async function instagramFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const message = typeof data?.error?.message === 'string' ? data.error.message : 'Instagram API so‘rovi bajarilmadi';
    throw new Error(message.slice(0, 300));
  }
  return data;
}

async function instagramAccount() {
  const result = await pool.query(
    'SELECT id, ig_user_id, username, access_token_encrypted, token_expires_at, webhook_subscribed, connected_at FROM instagram_accounts WHERE id = $1',
    [INSTAGRAM_SINGLETON_ID],
  );
  return result.rows[0] || null;
}

async function instagramAccessToken(account: any) {
  let token = decryptInstagramToken(account.access_token_encrypted);
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (expiresAt && expiresAt <= Date.now()) throw new ServiceUnavailableException('Instagram sessiyasi tugagan. Akkauntni qayta ulang.');
  if (expiresAt && expiresAt - Date.now() < 10 * 24 * 60 * 60 * 1000) {
    try {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', token);
      const refreshed: any = await instagramFetch(url.toString());
      if (typeof refreshed.access_token === 'string') {
        token = refreshed.access_token;
        const seconds = Number(refreshed.expires_in) || 5184000;
        await pool.query(
          'UPDATE instagram_accounts SET access_token_encrypted = $1, token_expires_at = $2 WHERE id = $3',
          [encryptInstagramToken(token), new Date(Date.now() + seconds * 1000), INSTAGRAM_SINGLETON_ID],
        );
      }
    } catch {
      throw new ServiceUnavailableException('Instagram tokenini yangilab bo‘lmadi. Akkauntni qayta ulang.');
    }
  }
  return token;
}

function instagramFrontendRedirect(result: string, webhook: string) {
  const origin = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
  const url = new URL('/', origin);
  url.searchParams.set('instagram', result);
  if (webhook) url.searchParams.set('webhook', webhook);
  return url.toString();
}

async function persistInstagramWebhookEvent(entry: any, event: any) {
  const accountId = String(entry?.id || '');
  const message = event?.message;
  if (!accountId || !message || message.is_deleted || message.is_unsent) return;
  const account = await pool.query('SELECT ig_user_id FROM instagram_accounts WHERE id = $1 AND ig_user_id = $2', [INSTAGRAM_SINGLETON_ID, accountId]);
  if (!account.rowCount) return;

  const senderId = String(event?.sender?.id || '');
  const recipientId = String(event?.recipient?.id || '');
  const echo = Boolean(message.is_echo) || senderId === accountId;
  const customerId = echo ? recipientId : senderId;
  if (!customerId || customerId === accountId) return;

  const direction = echo ? 'outbound' : 'inbound';
  const timestamp = Number(event.timestamp) || Date.now();
  const sentAt = new Date(timestamp);
  const text = typeof message.text === 'string' ? message.text.slice(0, 5000) : '';
  const attachments = (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 10).map((item: any) => ({
    type: typeof item?.type === 'string' ? item.type.slice(0, 40) : 'file',
    url: typeof item?.payload?.url === 'string' && item.payload.url.startsWith('https://') ? item.payload.url.slice(0, 2000) : null,
  }));
  const fallback = attachments.length ? '[' + attachments.map((item: any) => item.type).join(', ') + ']' : '';
  const lastText = text || fallback;
  const externalId = String(message.mid || message.id || createHash('sha256').update([accountId, customerId, direction, timestamp, text].join(':')).digest('hex'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversation = await client.query(
      'INSERT INTO instagram_conversations (ig_user_id, sender_id, sender_username, last_message_text, last_message_at, last_inbound_at) ' +
      'VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 = \'inbound\' THEN $5 ELSE NULL END) ' +
      'ON CONFLICT (ig_user_id, sender_id) DO UPDATE SET ' +
      'sender_username = COALESCE(NULLIF(EXCLUDED.sender_username, \'\'), instagram_conversations.sender_username), ' +
      'last_message_text = EXCLUDED.last_message_text, ' +
      'last_message_at = GREATEST(instagram_conversations.last_message_at, EXCLUDED.last_message_at), ' +
      'last_inbound_at = CASE WHEN $6 = \'inbound\' THEN GREATEST(COALESCE(instagram_conversations.last_inbound_at, EXCLUDED.last_inbound_at), EXCLUDED.last_inbound_at) ELSE instagram_conversations.last_inbound_at END, ' +
      'updated_at = NOW() RETURNING id',
      [accountId, customerId, echo ? '' : String(event?.sender?.username || '').slice(0, 100), lastText, sentAt, direction],
    );
    const inserted = await client.query(
      'INSERT INTO instagram_messages (conversation_id, external_message_id, direction, message_text, attachments, sent_at) ' +
      'VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (external_message_id) DO NOTHING RETURNING id',
      [conversation.rows[0].id, externalId, direction, text, JSON.stringify(attachments), sentAt],
    );
    if (inserted.rowCount && direction === 'inbound') {
      await client.query('UPDATE instagram_conversations SET unread_count = unread_count + 1 WHERE id = $1', [conversation.rows[0].id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function persistInstagramWebhook(body: any) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const event of events) await persistInstagramWebhookEvent(entry, event);
  }
}

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
  // INSTAGRAM DIRECT
  // ----------------------------------------

  @Get('instagram/status')
  @UseGuards(AuthGuard)
  async instagramStatus() {
    const account = await instagramAccount();
    return {
      connected: Boolean(account),
      setupReady: instagramIsConfigured(),
      username: account?.username || null,
      igUserId: account?.ig_user_id || null,
      connectedAt: account?.connected_at || null,
      tokenExpiresAt: account?.token_expires_at || null,
      webhookSubscribed: Boolean(account?.webhook_subscribed),
    };
  }

  @Get('instagram/connect')
  @UseGuards(AuthGuard)
  async instagramConnect(@Req() req: AuthRequest) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Instagram akkauntini faqat administrator ulashi mumkin');
    const config = instagramConfig();
    const state = await this.jwt.signAsync({ sub: req.user.id, purpose: 'instagram-connect' }, { expiresIn: '10m' });
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'instagram_business_basic,instagram_business_manage_messages');
    url.searchParams.set('state', state);
    return { url: url.toString() };
  }

  @Get('instagram/callback')
  async instagramCallback(@Query('code') code: string, @Query('state') state: string, @Query('error') oauthError: string, @Res() res: any) {
    if (oauthError || !code || !state) return res.redirect(302, instagramFrontendRedirect('error', ''));
    try {
      const config = instagramConfig();
      const claims: any = await this.jwt.verifyAsync(state);
      const userId = Number(claims?.sub);
      if (claims?.purpose !== 'instagram-connect' || !Number.isSafeInteger(userId) || userId < 1) {
        return res.redirect(302, instagramFrontendRedirect('error', ''));
      }
      const user = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!user.rowCount) return res.redirect(302, instagramFrontendRedirect('error', ''));

      const tokenForm = new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
        code,
      });
      const shortToken: any = await instagramFetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenForm.toString(),
      });
      if (typeof shortToken.access_token !== 'string') throw new Error('Instagram token exchange failed');

      const longTokenUrl = new URL('https://graph.instagram.com/access_token');
      longTokenUrl.searchParams.set('grant_type', 'ig_exchange_token');
      longTokenUrl.searchParams.set('client_secret', config.appSecret);
      longTokenUrl.searchParams.set('access_token', shortToken.access_token);
      const longToken: any = await instagramFetch(longTokenUrl.toString());
      const accessToken = typeof longToken.access_token === 'string' ? longToken.access_token : shortToken.access_token;
      const profileUrl = new URL('https://graph.instagram.com/' + config.apiVersion + '/me');
      profileUrl.searchParams.set('fields', 'user_id,username');
      profileUrl.searchParams.set('access_token', accessToken);
      const profile: any = await instagramFetch(profileUrl.toString());
      const igUserId = String(profile.user_id || profile.id || shortToken.user_id || '');
      if (!igUserId) throw new Error('Instagram account ID was not returned');
      const username = String(profile.username || 'Instagram account').slice(0, 100);
      const expiresIn = Number(longToken.expires_in) || Number(shortToken.expires_in) || 5184000;
      let webhookSubscribed = false;
      try {
        const subscribeUrl = new URL('https://graph.instagram.com/' + config.apiVersion + '/' + encodeURIComponent(igUserId) + '/subscribed_apps');
        subscribeUrl.searchParams.set('subscribed_fields', 'messages');
        const subscription: any = await instagramFetch(subscribeUrl.toString(), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + accessToken },
        });
        webhookSubscribed = subscription.success === true || subscription.success === 'true';
      } catch {
        webhookSubscribed = false;
      }

      await pool.query(
        'INSERT INTO instagram_accounts (id, ig_user_id, username, access_token_encrypted, token_expires_at, webhook_subscribed, connected_by, connected_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) ' +
        'ON CONFLICT (id) DO UPDATE SET ig_user_id = EXCLUDED.ig_user_id, username = EXCLUDED.username, ' +
        'access_token_encrypted = EXCLUDED.access_token_encrypted, token_expires_at = EXCLUDED.token_expires_at, ' +
        'webhook_subscribed = EXCLUDED.webhook_subscribed, connected_by = EXCLUDED.connected_by, connected_at = NOW()',
        [INSTAGRAM_SINGLETON_ID, igUserId, username, encryptInstagramToken(accessToken), new Date(Date.now() + expiresIn * 1000), webhookSubscribed, userId],
      );
      return res.redirect(302, instagramFrontendRedirect('connected', webhookSubscribed ? '' : 'check'));
    } catch {
      return res.redirect(302, instagramFrontendRedirect('error', ''));
    }
  }

  @Post('instagram/disconnect')
  @UseGuards(AuthGuard)
  async instagramDisconnect(@Req() req: AuthRequest) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Instagram akkauntini faqat administrator uzishi mumkin');
    await pool.query('DELETE FROM instagram_accounts WHERE id = $1', [INSTAGRAM_SINGLETON_ID]);
    return { ok: true };
  }

  @Get('instagram/conversations')
  @UseGuards(AuthGuard)
  async instagramConversations() {
    const { rows } = await pool.query(
      'SELECT id, sender_id AS "senderId", sender_username AS username, last_message_text AS "lastMessage", ' +
      'last_message_at AS "lastMessageAt", last_inbound_at AS "lastInboundAt", unread_count AS "unreadCount" ' +
      'FROM instagram_conversations ORDER BY last_message_at DESC LIMIT 200',
    );
    return rows;
  }

  @Get('instagram/conversations/:id/messages')
  @UseGuards(AuthGuard)
  async instagramMessages(@Param('id') rawId: string) {
    const id = parse(z.coerce.number().int().positive(), rawId);
    const conversation = await pool.query('UPDATE instagram_conversations SET unread_count = 0 WHERE id = $1 RETURNING id', [id]);
    if (!conversation.rowCount) throw new NotFoundException('Instagram suhbati topilmadi');
    const { rows } = await pool.query(
      'SELECT id, direction, message_text AS text, attachments, sent_at AS "sentAt" ' +
      'FROM instagram_messages WHERE conversation_id = $1 ORDER BY sent_at DESC, id DESC LIMIT 200',
      [id],
    );
    return rows.reverse();
  }

  @Post('instagram/conversations/:id/messages')
  @UseGuards(AuthGuard)
  async instagramSendMessage(@Param('id') rawId: string, @Body() body: unknown) {
    const id = parse(z.coerce.number().int().positive(), rawId);
    const data = parse(z.object({ text: z.string().trim().min(1).max(1000) }).strict(), body);
    const { rows } = await pool.query(
      'SELECT c.id, c.sender_id, c.last_inbound_at, a.ig_user_id ' +
      'FROM instagram_conversations c JOIN instagram_accounts a ON a.ig_user_id = c.ig_user_id AND a.id = $2 ' +
      'WHERE c.id = $1',
      [id, INSTAGRAM_SINGLETON_ID],
    );
    const conversation = rows[0];
    if (!conversation) throw new NotFoundException('Instagram suhbati topilmadi');
    const lastInboundAt = conversation.last_inbound_at ? new Date(conversation.last_inbound_at).getTime() : 0;
    if (!lastInboundAt || Date.now() - lastInboundAt > INSTAGRAM_24_HOURS_MS) {
      throw new BadRequestException('24 soatlik javob oynasi tugagan. Instagram orqali javob yuborib bo‘lmaydi.');
    }

    const account = await instagramAccount();
    if (!account) throw new ServiceUnavailableException('Instagram akkaunti ulanmagan');
    const config = instagramConfig();
    const accessToken = await instagramAccessToken(account);
    const sendUrl = 'https://graph.instagram.com/' + config.apiVersion + '/' + encodeURIComponent(conversation.ig_user_id) + '/messages';
    let sent: any;
    try {
      sent = await instagramFetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({ recipient: { id: conversation.sender_id }, message: { text: data.text } }),
      });
    } catch {
      throw new ServiceUnavailableException('Instagram xabarni yubormadi. Ulanishni yoki Meta ruxsatlarini tekshiring.');
    }

    const sentAt = new Date();
    const externalId = String(sent.message_id || sent.id || 'crm:' + randomUUID());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO instagram_messages (conversation_id, external_message_id, direction, message_text, attachments, sent_at) ' +
        'VALUES ($1, $2, \'outbound\', $3, \'[]\'::jsonb, $4) ON CONFLICT (external_message_id) DO NOTHING',
        [id, externalId, data.text, sentAt],
      );
      await client.query(
        'UPDATE instagram_conversations SET last_message_text = $1, last_message_at = $2, updated_at = NOW() WHERE id = $3',
        [data.text, sentAt, id],
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
    return { ok: true, messageId: externalId, sentAt };
  }

  @Get('instagram/webhook')
  async instagramWebhookVerify(@Query('hub.mode') mode: string, @Query('hub.verify_token') verifyToken: string, @Query('hub.challenge') challenge: string, @Res() res: any) {
    const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || '';
    if (!expected || mode !== 'subscribe' || !constantTimeTextEqual(verifyToken || '', expected)) {
      return res.status(403).type('text/plain').send('Forbidden');
    }
    return res.status(200).type('text/plain').send(challenge || '');
  }

  @Post('instagram/webhook')
  @HttpCode(200)
  async instagramWebhook(@Req() req: any) {
    const appSecret = process.env.INSTAGRAM_APP_SECRET || '';
    const rawBody = req.rawBody;
    const signature = String(req.headers?.['x-hub-signature-256'] || '');
    if (!appSecret || !Buffer.isBuffer(rawBody) || !signature.startsWith('sha256=')) {
      throw new UnauthorizedException('Instagram webhook imzosi noto‘g‘ri');
    }
    const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
    if (!constantTimeTextEqual(signature, expected)) throw new UnauthorizedException('Instagram webhook imzosi noto‘g‘ri');
    await persistInstagramWebhook(req.body);
    return { received: true };
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
    rawBody: true,
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
