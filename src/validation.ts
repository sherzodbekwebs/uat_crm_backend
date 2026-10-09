import {z} from 'zod';
export const statuses=['new','contacted','offer','negotiation','won','lost'] as const;
export const leadSchema=z.object({
 fullName:z.string().trim().min(2).max(120), company:z.string().trim().max(160).default(''),
 industry:z.string().trim().min(1).max(120), region:z.string().trim().min(1).max(100), city:z.string().trim().min(1).max(100),
 customerType:z.enum(['legal','entrepreneur','individual']),
 products:z.array(z.object({id:z.string().max(100),name:z.string().min(1).max(250)}).strict()).min(1).max(30),
 paymentType:z.enum(['cash','leasing','installment','transfer','undecided']), offerSent:z.enum(['yes','no']),
 rejectionReason:z.enum(['','expensive','unsuitable','price_only','other']).default(''), rejectionOther:z.string().trim().max(1000).default(''),
 phone:z.string().transform(s=>s.replace(/[\s()-]/g,'')).pipe(z.string().regex(/^\+\d{9,15}$/,'Telefonni +998901234567 shaklida kiriting')),
 source:z.enum(['website','instagram','phone','telegram','visit','referral','other']), sourceOther:z.string().trim().max(200).default(''),
 operatorId:z.number().int().positive(), status:z.enum(statuses).default('new'),
 notes:z.string().trim().max(5000).default(''), followUpAt:z.string().datetime({offset:true}).nullable().default(null),
 amount:z.number().min(0).max(1e15).default(0)
}).strict().superRefine((v,c)=>{
 if(v.status==='lost'&&!v.rejectionReason)c.addIssue({code:'custom',path:['rejectionReason'],message:'Rad etish sababini tanlang'});
 if(v.rejectionReason==='other'&&!v.rejectionOther)c.addIssue({code:'custom',path:['rejectionOther'],message:'Boshqa sababni yozing'});
 if(v.source==='other'&&!v.sourceOther)c.addIssue({code:'custom',path:['sourceOther'],message:'Manbani yozing'});
});
export function normalizeProducts(raw:any) {
 const rows=Array.isArray(raw)?raw:[raw?.data,raw?.products,raw?.items,raw?.results,raw?.data?.products,raw?.data?.items].find(Array.isArray);
 if(!rows) throw new Error('Unknown products response shape');
 return rows.map((p:any)=>{const n=p.titleUz||p.titleRu||p.titleEn||p.name||p.title||p.name_uz||p.title_uz;const name=typeof n==='string'?n:n?.uz??n?.ru??n?.en;return {id:String(p.id??p._id??p.slug??''),name};}).filter((p:any)=>p.id&&typeof p.name==='string'&&p.name.trim());
}
