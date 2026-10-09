"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.leadSchema = exports.statuses = void 0;
exports.normalizeProducts = normalizeProducts;
const zod_1 = require("zod");
exports.statuses = ['new', 'contacted', 'offer', 'negotiation', 'won', 'lost'];
exports.leadSchema = zod_1.z.object({
    fullName: zod_1.z.string().trim().min(2).max(120), company: zod_1.z.string().trim().max(160).default(''),
    industry: zod_1.z.string().trim().min(1).max(120), region: zod_1.z.string().trim().min(1).max(100), city: zod_1.z.string().trim().min(1).max(100),
    customerType: zod_1.z.enum(['legal', 'entrepreneur', 'individual']),
    products: zod_1.z.array(zod_1.z.object({ id: zod_1.z.string().max(100), name: zod_1.z.string().min(1).max(250) }).strict()).min(1).max(30),
    paymentType: zod_1.z.enum(['cash', 'leasing', 'installment', 'transfer', 'undecided']), offerSent: zod_1.z.enum(['yes', 'no']),
    rejectionReason: zod_1.z.enum(['', 'expensive', 'unsuitable', 'price_only', 'other']).default(''), rejectionOther: zod_1.z.string().trim().max(1000).default(''),
    phone: zod_1.z.string().transform(s => s.replace(/[\s()-]/g, '')).pipe(zod_1.z.string().regex(/^\+\d{9,15}$/, 'Telefonni +998901234567 shaklida kiriting')),
    source: zod_1.z.enum(['website', 'instagram', 'phone', 'telegram', 'visit', 'referral', 'other']), sourceOther: zod_1.z.string().trim().max(200).default(''),
    operatorId: zod_1.z.number().int().positive(), status: zod_1.z.enum(exports.statuses).default('new'),
    notes: zod_1.z.string().trim().max(5000).default(''), followUpAt: zod_1.z.string().datetime({ offset: true }).nullable().default(null),
    amount: zod_1.z.number().min(0).max(1e15).default(0)
}).strict().superRefine((v, c) => {
    if (v.status === 'lost' && !v.rejectionReason)
        c.addIssue({ code: 'custom', path: ['rejectionReason'], message: 'Rad etish sababini tanlang' });
    if (v.rejectionReason === 'other' && !v.rejectionOther)
        c.addIssue({ code: 'custom', path: ['rejectionOther'], message: 'Boshqa sababni yozing' });
    if (v.source === 'other' && !v.sourceOther)
        c.addIssue({ code: 'custom', path: ['sourceOther'], message: 'Manbani yozing' });
});
function normalizeProducts(raw) {
    const rows = Array.isArray(raw) ? raw : [raw?.data, raw?.products, raw?.items, raw?.results, raw?.data?.products, raw?.data?.items].find(Array.isArray);
    if (!rows)
        throw new Error('Unknown products response shape');
    return rows.map((p) => { const n = p.titleUz || p.titleRu || p.titleEn || p.name || p.title || p.name_uz || p.title_uz; const name = typeof n === 'string' ? n : n?.uz ?? n?.ru ?? n?.en; return { id: String(p.id ?? p._id ?? p.slug ?? ''), name }; }).filter((p) => p.id && typeof p.name === 'string' && p.name.trim());
}
