import {test} from 'node:test';
import assert from 'node:assert/strict';
import {leadSchema,normalizeProducts} from './validation';
const base={fullName:'Test Mijoz',industry:'Logistika',region:'Toshkent shahri',city:'Yashnobod',customerType:'legal',products:[{id:'abc',name:'JAC X200'}],paymentType:'leasing',offerSent:'no',phone:'+998 (90) 123-45-67',source:'phone',operatorId:1};
test('Normalizes phone and supplies defaults',()=>{const x=leadSchema.parse(base);assert.equal(x.phone,'+998901234567');assert.equal(x.status,'new')});
test('Lost lead requires rejection reason and other requires explanation',()=>{assert.equal(leadSchema.safeParse({...base,status:'lost'}).success,false);assert.equal(leadSchema.safeParse({...base,status:'lost',rejectionReason:'other'}).success,false);assert.equal(leadSchema.safeParse({...base,status:'lost',rejectionReason:'other',rejectionOther:'Yetkazish muddati'}).success,true)});
test('Requires product, valid phone and source detail',()=>{for(const patch of [{products:[]},{phone:'123'},{source:'other'},{operatorId:-1},{amount:-1},{unexpected:true}])assert.equal(leadSchema.safeParse({...base,...patch}).success,false)});
test('Maps actual UAT camelCase localized titles',()=>{assert.deepEqual(normalizeProducts([{id:'1',titleUz:'Tortuvchi',titleRu:'Тягач'}]),[{id:'1',name:'Tortuvchi'}]);assert.deepEqual(normalizeProducts({data:[{id:2,titleUz:'',titleRu:'Полуприцеп'}]}),[{id:'2',name:'Полуприцеп'}]);assert.throws(()=>normalizeProducts({error:'failure'}))});
