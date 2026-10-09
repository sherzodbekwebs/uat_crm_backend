"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
require("dotenv/config");
const pg_1 = require("pg");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const bcryptjs_1 = require("bcryptjs");
exports.pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
async function run() {
    if (!process.env.DATABASE_URL)
        throw new Error('DATABASE_URL is required');
    if (process.argv[2] === 'migrate') {
        const client = await exports.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(8241001)');
            await client.query((0, node_fs_1.readFileSync)((0, node_path_1.resolve)(__dirname, '../sql/001-init.sql'), 'utf8'));
            await client.query('COMMIT');
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
        console.log('Database migration complete');
    }
    else if (process.argv[2] === 'seed') {
        const users = [['admin', 'Admin', 'admin', 'ADMIN_PASSWORD'], ['rahima', 'Rahima', 'operator', 'RAHIMA_PASSWORD'], ['amirshoh', 'Amirshoh', 'operator', 'AMIRSHOH_PASSWORD']];
        for (const [, , , key] of users)
            if ((process.env[key] || '').length < 10)
                throw new Error(`${key} must contain at least 10 characters`);
        for (const [username, name, role, key] of users)
            await exports.pool.query('INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING', [username, name, role, await (0, bcryptjs_1.hash)(process.env[key], 12)]);
        console.log('Accounts created (existing passwords preserved)');
    }
    await exports.pool.end();
}
if (require.main === module)
    run().catch(e => { console.error(e.message); process.exit(1); });
