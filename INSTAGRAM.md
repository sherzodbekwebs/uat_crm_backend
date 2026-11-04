# Instagram Direct setup

CRM uses Meta's Instagram API with Unified Login (Facebook Login for Business configuration). It connects one shared Instagram professional account for the CRM; authorized CRM operators can read and reply to its conversations.

## Requirements

- An Instagram Business or Creator account. Personal accounts are not supported by this API.
- A Meta app configured for Instagram API with Unified Login and a Facebook Login for Business configuration.
- The configuration must use a System-user access token and grant `instagram_basic` and `instagram_manage_messages` to the Instagram business asset.
- A public HTTPS backend URL for OAuth and webhooks.
- For development, the Instagram account must be added as an Instagram Tester and accept the invitation. Live access for accounts outside the app's roles requires the relevant Meta review and access approvals.

## Meta app configuration

1. In the Meta developer dashboard, choose **Manage messaging & content on Instagram** and use **API setup with Unified Login**. Create a configuration with General login variation, System-user access token, the Instagram account asset, and only the needed messaging/basic permissions.
2. Add the exact OAuth callback URI in the Unified Login setup:
   `https://crm-api.uzautotrailer.uz/api/instagram/callback`
   Change the host if this backend is deployed elsewhere.
3. Configure the Instagram webhook callback:
   `https://crm-api.uzautotrailer.uz/api/instagram/webhook`
   Use the same random value as `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, then subscribe to the `messages` field and enable the account's webhook subscription.
4. Keep the CRM callback and Meta's login flow on the same exact HTTPS redirect URI.

## Backend environment

Set these values in the backend's production environment (do not commit them):

- `INSTAGRAM_APP_ID`: Meta app ID from **App settings → Basic** (not the configuration ID or Instagram account ID).
- `INSTAGRAM_APP_SECRET`: app secret; also used to validate webhook signatures.
- `INSTAGRAM_CONFIG_ID`: ID of the Instagram API (Unified Login) configuration.
- `INSTAGRAM_ACCOUNT_ID`: ID of the Instagram professional account selected for this CRM.
- `INSTAGRAM_REDIRECT_URI`: exact callback URI configured in Meta.
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`: random secret used when Meta verifies the webhook.
- `INSTAGRAM_TOKEN_ENCRYPTION_KEY`: 32-byte key encoded as 64 hexadecimal characters. Generate with `openssl rand -hex 32`.
- `INSTAGRAM_GRAPH_API_VERSION`: defaults to `v26.0`.

Set `FRONTEND_ORIGIN` to the real CRM origin. If it contains a comma-separated
allowlist, the first origin is the OAuth return destination. Do not leave a
localhost origin first in production. Restart the cPanel Node application after
changing environment variables.

OAuth uses Meta's `facebook.com/dialog/oauth` endpoint with `config_id`; token exchange and Instagram messaging calls use `graph.facebook.com`. The system-user token is stored encrypted with AES-256-GCM. Keep the encryption key stable; changing it requires reconnecting Instagram. The Meta app secret and access token must never be placed in the frontend or committed to Git.

After deploying the backend, run the additive database migration once from the backend app root:

```sh
node dist/database.js migrate
```

Then sign in to the CRM as an administrator and choose **Instagram Direct → Instagramni ulash**.

## Message limits

The CRM only enables replies for conversations where the Instagram user has messaged the connected account, and disables replies after the 24-hour response window. The official API does not support group conversations.

Official references:
- [Meta Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/)
- [Instagram Messaging API overview](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/messaging-api)

