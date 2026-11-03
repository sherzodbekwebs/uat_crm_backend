# Instagram Direct setup

CRM uses Meta's official Instagram API with Instagram Login. It connects one shared Instagram professional account for the CRM; authorized CRM operators can read and reply to its conversations.

## Requirements

- An Instagram Business or Creator account. Personal accounts are not supported by this API.
- A Meta app configured for Instagram API with Instagram Login.
- The app must have `instagram_business_basic` and `instagram_business_manage_messages`.
- A public HTTPS backend URL for OAuth and webhooks.
- Meta access review for accounts outside the app's own roles/testers. Until that is granted, use an app-role test account.

## Meta app configuration

1. In the Meta developer dashboard, add Instagram API with Instagram Login.
2. Add the exact OAuth callback URI to the valid OAuth redirect URIs:
   `https://crm-api.uzautotrailer.uz/api/instagram/callback`
   Change the host if this backend is deployed elsewhere.
3. Configure the Instagram webhook callback:
   `https://crm-api.uzautotrailer.uz/api/instagram/webhook`
   Use the same random value as `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, then subscribe to the `messages` field.
4. Request the two permissions listed above. App Review/Advanced Access is needed to serve accounts outside the app's own roles.

## Backend environment

Set these values in the backend's production environment (do not commit them):

- `INSTAGRAM_APP_ID`: Instagram app ID from the Meta dashboard.
- `INSTAGRAM_APP_SECRET`: app secret; also used to validate webhook signatures.
- `INSTAGRAM_REDIRECT_URI`: exact callback URI configured in Meta.
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`: random secret used when Meta verifies the webhook.
- `INSTAGRAM_TOKEN_ENCRYPTION_KEY`: 32-byte key encoded as 64 hexadecimal characters. Generate with `openssl rand -hex 32`.
- `INSTAGRAM_GRAPH_API_VERSION`: defaults to `v26.0`.

The OAuth token is stored encrypted with AES-256-GCM. Keep the encryption key stable; changing it requires reconnecting Instagram. The Meta app secret and access token must never be placed in the frontend.

Set `FRONTEND_ORIGIN` to the real CRM origin. If it contains a comma-separated
allowlist, the first origin is the OAuth return destination. Do not leave a
localhost origin first in production. Restart the cPanel Node application after
changing environment variables.

After deploying the backend, run the additive database migration once from the backend app root:

```sh
node dist/database.js migrate
```

Then sign in to the CRM as an administrator and choose **Instagram Direct → Instagramni ulash**.

## Message limits

The CRM only enables replies for conversations where the Instagram user has messaged the connected account, and disables replies after the 24-hour response window. The official API does not support group conversations.

Official references:
- [Meta Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Instagram Messaging API overview](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api)
- [Business Login for Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)

