# Instagram Direct — Meta Unified Login

The CRM uses Meta's **Instagram API with Unified Login** through Facebook Login for Business. The account owner can sign in with Instagram or Facebook. A Facebook Page is not required. This is the setup shown for the existing `UAT CRM` app.

## Meta app configuration

1. In Meta Developers, open `UAT CRM` under the **Sherzod** profile. Keep the existing app and the **Manage messaging & content on Instagram** use case.
2. Open **Use cases → Manage messaging & content on Instagram → Customize → API setup with Unified login**. The app already has a selected configuration marked **Instagram Login Compatible**; the screenshot showed configuration ID `2282467869287683`.
3. Edit or create a configuration that asks only for the Instagram asset and these permissions:
   - `instagram_basic`
   - `instagram_manage_messages`

   Do not request ad account, publishing, comments, or insights permissions for this CRM inbox unless the product later needs them.
4. Register this exact HTTPS redirect URL in the selected configuration:
   `https://crm-api.uzautotrailer.uz/api/instagram/callback`
5. Add `uzautotrailer_official` as an **Instagram Tester** while the app is in Development mode. The Instagram account owner must accept the invite in Instagram on the web: **Settings → Website permissions → Apps and websites → Tester Invites**.
6. Under **Configure webhooks**, set the callback URL to:
   `https://crm-api.uzautotrailer.uz/api/instagram/webhook`

   Use the backend's `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` and subscribe to `messages`.

The CRM generates the Business Login URL using the Meta App ID, selected `config_id`, callback URL, and a signed `state`. Meta returns a short-lived code; the backend exchanges it server-side for a Business Integration System User Access Token and reads the Instagram account shared in that login.

## Backend environment

Set these values in the backend's production environment. Never commit app secrets or access tokens:

- `INSTAGRAM_APP_ID` — Meta App ID from **App settings → Basic**.
- `INSTAGRAM_APP_SECRET` — Meta App Secret from **App settings → Basic**.
- `INSTAGRAM_CONFIG_ID` — configuration ID shown in **API setup with Unified login**. The current selected ID is `2282467869287683`.
- `INSTAGRAM_ACCOUNT_ID` — optional guard restricting the CRM to one specific Instagram professional account. Leave blank if the selected configuration shares exactly one account.
- `INSTAGRAM_REDIRECT_URI` — must exactly match the URL registered in Meta.
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` — random value used by Meta to verify the callback.
- `INSTAGRAM_TOKEN_ENCRYPTION_KEY` — 32-byte key in 64-character hexadecimal form. Generate with `openssl rand -hex 32`.
- `INSTAGRAM_GRAPH_API_VERSION` — defaults to `v27.0`.
- `FRONTEND_ORIGIN` — the real HTTPS CRM origin; it is where OAuth returns after connecting.

The backend stores the access token encrypted with AES-256-GCM. Keep the encryption key stable. If a configuration returns an expiring token, the CRM reports it disconnected after expiry and the Instagram account must be reconnected. Prefer a configuration with the appropriate token lifetime for the business's operational needs.

## Database and deployment

After deploying the backend, run the additive database migration once from the backend app root:

```sh
node dist/database.js migrate
```

Then sign in to the CRM as an administrator and choose **Instagram Direct → Instagramni ulash**. During Meta login, choose the Instagram login option, select the Instagram account, and approve the two requested permissions.

The app must be Live to receive webhook notifications. Production access also requires Meta's stated business verification and any applicable App Review/Advanced Access. Standard Access can be used for users with a role on the app; accounts without an app role require Advanced Access. For initial testing, add the Instagram account as an Instagram Tester and accept the invite.

## Messaging behavior

The CRM only enables replies for conversations where the Instagram user has messaged the connected account, and disables replies after the ordinary 24-hour response window. Group conversations are not supported.

Official Meta references:

- [Instagram API with Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login)
- [Get started with Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started)
- [Unified Login permissions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/permissions)
- [Unified Login authentication and tokens](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication)
- [Instagram webhook setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)
