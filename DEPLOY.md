# cPanel deploy

Foydalanuvchilarni boshqarish API allaqachon mavjud:
- GET /api/admin/users — ro‘yxat
- POST /api/admin/users — yaratish
- PUT /api/admin/users/:id — ism, rol va parolni yangilash

Bu endpointlar faqat administrator uchun. Testlar operatorga ruxsat
berilmasligini, login takrorlanishini, parol va rol yangilanishini tekshiradi.

## Bir marta sozlash

Application root: `uat-crm-backend` (foydalanuvchi tasdiqlagan).
FTP orqali ko‘rinadigan yo‘l hali tasdiqlanmagan.

1. cPanel Node.js ilovasida Node 24.22.1 va startup file `app.js` ni tanlang.
   Mavjud production bazasi va `.env` sozlamalarini saqlang.
2. Ilova papkasida `npm ci --omit=dev` bajaring (yoki cPanel Run NPM Install).
   FTP buyruq bajarmaydi: dependency o‘zgargan deploylarda bu qadam yana kerak.
   Mavjud `users` jadvali bo‘lsa, bu sahifa uchun yangi migratsiya talab qilinmaydi.
3. GitHub Settings → Secrets and variables → Actions ichida secrets:
   `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`.
4. Variables: `FTP_SERVER_DIR` — FTP orqali ko‘rinadigan aniq ilova papkasi
   (masalan `/crm-backend/`; cPanel absolute path bilan bir xil bo‘lishi shart emas),
   `FTP_PORT` — odatda `21`.
5. Server explicit FTPS va haqiqiy TLS sertifikatini qo‘llashi kerak.
6. Papka va dependencies tekshirilgach `CPANEL_DEPLOY_ENABLED=true` qo‘ying.

`main` ga push → npm test/build → runtime upload → Passenger restart → health check.
Secrets tayyor bo‘lmaguncha deploy o‘chirilgan, test va artifact build ishlaydi.
Qo‘lda ishga tushirish: Actions → Test and deploy backend → Run workflow.

Upload `.env`, `.git`, arxivlar, testlar va `node_modules` ni yubormaydi yoki
o‘chirmaydi. Production `.env` va cPanel boshqaradigan node_modules saqlanadi.
FTP upload atomik emas: qisqa texnik xizmat oynasida deploy qilish ma’qul.
Dependency va schema o‘zgarishlari alohida serverda bajarilishi kerak.

Ochiq repozitoriyda avval kuzatuvga olingan `.env` mavjud. Uni Git kuzatuvidan
chiqarish tarixdagi nusxani o‘chirmaydi; haqiqiy parol va kalitlarni almashtiring.

Passenger restart hujjati:
https://support.cpanel.net/hc/en-us/articles/1500002443862-How-to-restart-an-application-that-s-using-cPanel-s-Application-Manager
