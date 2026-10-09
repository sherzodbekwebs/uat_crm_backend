"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const validation_1 = require("./validation");
const base = { fullName: 'Test Mijoz', industry: 'Logistika', region: 'Toshkent shahri', city: 'Yashnobod', customerType: 'legal', products: [{ id: 'abc', name: 'JAC X200' }], paymentType: 'leasing', offerSent: 'no', phone: '+998 (90) 123-45-67', source: 'phone', operatorId: 1 };
(0, node_test_1.test)('Normalizes phone and supplies defaults', () => { const x = validation_1.leadSchema.parse(base); strict_1.default.equal(x.phone, '+998901234567'); strict_1.default.equal(x.status, 'new'); });
(0, node_test_1.test)('Lost lead requires rejection reason and other requires explanation', () => { strict_1.default.equal(validation_1.leadSchema.safeParse({ ...base, status: 'lost' }).success, false); strict_1.default.equal(validation_1.leadSchema.safeParse({ ...base, status: 'lost', rejectionReason: 'other' }).success, false); strict_1.default.equal(validation_1.leadSchema.safeParse({ ...base, status: 'lost', rejectionReason: 'other', rejectionOther: 'Yetkazish muddati' }).success, true); });
(0, node_test_1.test)('Requires product, valid phone and source detail', () => { for (const patch of [{ products: [] }, { phone: '123' }, { source: 'other' }, { operatorId: -1 }, { amount: -1 }, { unexpected: true }])
    strict_1.default.equal(validation_1.leadSchema.safeParse({ ...base, ...patch }).success, false); });
(0, node_test_1.test)('Maps actual UAT camelCase localized titles', () => { strict_1.default.deepEqual((0, validation_1.normalizeProducts)([{ id: '1', titleUz: 'Tortuvchi', titleRu: 'Тягач' }]), [{ id: '1', name: 'Tortuvchi' }]); strict_1.default.deepEqual((0, validation_1.normalizeProducts)({ data: [{ id: 2, titleUz: '', titleRu: 'Полуприцеп' }] }), [{ id: '2', name: 'Полуприцеп' }]); strict_1.default.throws(() => (0, validation_1.normalizeProducts)({ error: 'failure' })); });
