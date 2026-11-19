# Brinto.dev API

Run the API with Node.js 24. From this folder, use `npm run dev` for local development or `npm start` with `NODE_ENV=production` for production.

Use `.env.example` as the configuration reference. Set `OWNER_EMAIL` to the email address you control, `MONGODB_URI` to the complete connection string, and `DB_NAME` to the database to use. If you need a new backend secret, generate one in a private terminal with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and store it only in the backend environment. Use `MONGODB_TRANSACTIONS=true` on a replica set or sharded deployment. A standalone MongoDB can run the API with this flag set to `false`, but the offline owner provisioning command requires transactions.

`BETTER_AUTH_URL` is the public Next.js origin, for example `http://localhost:3000` during local development and `https://brinto.dev` in production. Match the exact scheme, hostname, and port used in the browser. In the frontend, `BACKEND_ORIGIN` defaults to `http://127.0.0.1:5000`. If you deploy the services separately, set it to the internal Express origin before running `npm run build`. Set backend `HOST` to an address that Next.js can reach over your private network. Keep the backend listener private and expose the Next.js origin to browsers.

The API connects to MongoDB and creates its application indexes before listening. `GET /api/health` checks HTTP liveness, and `GET /api/ready` pings the database. `GET /api/auth/ok` checks the Better Auth handler. `GET /api/admin/session` requires an active session for the verified owner email. New application collections without indexes will be created by MongoDB when first written.

Better Auth uses shared per-path rate limits because the Next.js rewrite does not establish a trusted client IP header. Apply per-client limits at the public gateway if your deployment needs them.

## Provision the owner

Confirm the target database and `OWNER_EMAIL` before running this command. The CLI creates a Better Auth credential account with a verified owner email through a server-only call. The HTTP app leaves email registration disabled and does not load the admin plugin. The command refuses to replace an existing account.

From this folder in PowerShell 7.2 or later, enter a unique password of 12–128 characters from your password manager. The masked input is piped to the process and does not appear in the command line.

```powershell
Read-Host -MaskInput 'Owner password' | npm run --silent owner:provision
```

After provisioning, use Better Auth's `signIn.email` from the frontend client or call its same-origin endpoint `POST /api/auth/sign-in/email`. Then check `GET /api/admin/session` with the resulting cookie.
