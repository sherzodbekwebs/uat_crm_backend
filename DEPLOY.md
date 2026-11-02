# cPanel deploy

Foydalanuvchilarni boshqarish API allaqachon mavjud:
- GET /api/admin/users — ro‘yxat
- POST /api/admin/users — yaratish
- PUT /api/admin/users/:id — ism, rol va parolni yangilash

Bu endpointlar faqat administrator uchun. Testlar operatorga ruxsat
berilmasligini, login takrorlanishini, parol va rol yangilanishini tekshiradi.

## Bir marta sozlash

Application root: `uat-crm-backend` (foydalanuvchi tasdiqlagan).
FTP hisobi ilova papkasiga cheklangan: FTP_SERVER_DIR=/, FTP_PORT=21.

1. cPanel Node.js ilovasida Node 24.22.1 va startup file `app.js` ni tanlang.
   Mavjud production bazasi va `.env` sozlamalarini saqlang.
2. Ilova papkasida `npm ci --omit=dev` bajaring (yoki cPanel Run NPM Install).
   FTP buyruq bajarmaydi: dependency o‘zgargan deploylarda bu qadam yana kerak.
   Mavjud production `.env` sozlamalarini saqlang; GitHub’dan `.env` yuklanmaydi.
3. GitHub Settings → Secrets and variables → Actions ichida secrets:
   `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`.
4. Variables: `FTP_SERVER_DIR` — FTP orqali ko‘rinadigan aniq ilova papkasi
   (masalan `/crm-backend/`; cPanel absolute path bilan bir xil bo‘lishi shart emas),
   `FTP_PORT` — odatda `21`.
5. Foydalanuvchi tanloviga ko‘ra oddiy FTP ishlatiladi (TLS yo‘q).
6. Instagram Direct yoqilganda `INSTAGRAM.md` dagi Meta sozlamalarini backend `.env` ga kiriting. `INSTAGRAM_REDIRECT_URI` Meta’dagi callback URL bilan aynan bir xil bo‘lishi kerak.
7. Backend deploy bo‘lgach, jadval migratsiyasini cPanel ilova papkasida bir marta bajaring: `node dist/database.js migrate`. Deploy workflow migratsiyani avtomatik bajarmaydi.
8. Deploy yoqilgan. To‘xtatish uchun `CPANEL_DEPLOY_ENABLED=false` qo‘ying.

`main` ga push → npm test/build → runtime upload → Passenger restart → health check.
Main ga push avtomatik deploy qiladi; secrets va variables talab qilinadi.
Qo‘lda ishga tushirish: Actions → Test and deploy backend → Run workflow.

Upload `.env`, `.git`, arxivlar, testlar va `node_modules` ni yubormaydi yoki
o‘chirmaydi. Production `.env` va cPanel boshqaradigan node_modules saqlanadi.
FTP upload atomik emas: qisqa texnik xizmat oynasida deploy qilish ma’qul.
Dependency va schema o‘zgarishlari alohida server qadamlarini talab qiladi. Instagram uchun yuqoridagi migratsiya buyrug‘idan foydalaning.

Ochiq repozitoriyda `.env` fayli Git kuzatuvida turibdi. Uni Git kuzatuvidan chiqarish tarixdagi nusxani o‘chirmaydi; unda bo‘lgan haqiqiy parol va kalitlarni almashtiring.

Passenger restart hujjati:
https://support.cpanel.net/hc/en-us/articles/1500002443862-How-to-restart-an-application-that-s-using-cPanel-s-Application-Manager
