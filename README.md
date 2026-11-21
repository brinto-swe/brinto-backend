# Brinto.dev API

Run the API with Node.js 24. From this folder, use `npm run dev` for local development or `npm start` with `NODE_ENV=production` for production.

Use `.env.example` as the configuration reference. Set `OWNER_EMAIL` to the email address you control, `MONGODB_URI` to the complete connection string, and `DB_NAME` to the database to use. If you need a new backend secret, generate one in a private terminal with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and store it only in the backend environment. Use `MONGODB_TRANSACTIONS=true` on a replica set or sharded deployment. A standalone MongoDB can run the API with this flag set to `false`, but the offline owner provisioning command requires transactions.

`BETTER_AUTH_URL` is the public Next.js origin, for example `http://localhost:3000` during local development and `https://brinto.dev` in production. Match the exact scheme, hostname, and port used in the browser. In the frontend, `BACKEND_ORIGIN` defaults to `http://127.0.0.1:5000`. If you deploy the services separately, set it to the internal Express origin before running `npm run build`. Set backend `HOST` to an address that Next.js can reach over your private network. Keep the backend listener private and expose the Next.js origin to browsers.

The API connects to MongoDB and creates its application indexes before listening. `GET /api/health` checks HTTP liveness, and `GET /api/ready` pings the database. `GET /api/auth/ok` checks the Better Auth handler. `GET /api/admin/session` requires an active session for the verified owner email. New application collections without indexes will be created by MongoDB when first written.

Better Auth uses shared per-path rate limits because the Next.js rewrite does not establish a trusted client IP header. Apply per-client limits at the public gateway if your deployment needs them.

## Bundled Blog seed

From the backend folder, run `node scripts/seed-blog.js --dry-run` with both project folders present. The script reads the original frontend articles and their public bilingual byline. It validates the content and publication eligibility with the Blog API validators, then reads the configured MongoDB `posts` collection. The per-article report shows missing slugs, equivalent records, and conflicts. Dry run skips index preparation and performs no write.

The bundled articles are publicly listed and already dated. The seed maps each original `YYYY-MM-DD` to midnight UTC in `publishedAt` and requires the same eligibility and past-date checks as the API before marking it published. Reading times and ordered categories come from the source. Search text uses the backend's derived fields. Slugs stay unchanged and the seed ObjectId is deterministic. Insertion timestamps are assigned only when an actual insert occurs.

The future `--apply` mode requires explicit approval before use. It inserts only rows classified as missing, requires the existing full unique slug index, and rechecks duplicate-key races. Equivalent and conflicting records are skipped. The script never replaces or deletes posts and never creates collections or indexes manually.

## Admin image uploads

Set `IMGBB_API_KEY` in the Express runtime environment and restart Express. `MEDIA_IMAGE_MAX_BYTES` defaults to 5 MiB (5242880 bytes) and accepts up to 8 MiB (8388608 bytes). In production, allow the configured image limit plus 16 KiB of multipart overhead through the hosting ingress and any reverse proxy. Align the uploader’s `maxBytes` prop if you change the default. [ImgBB API documentation](https://api.imgbb.com/)

The same-origin `POST /api/admin/media/images` accepts one multipart `image` file and one `purpose` field. Supported purposes are `profile`, `project`, `certification-thumbnail`, `blog-cover`, and `blog-content`. Uploads accept still JPEG, PNG, or WebP up to 6000 × 6000 pixels and 20 megapixels. Express checks the owner session and origin, decodes and re-encodes the image, then sends it to ImgBB. The returned dimensions and file size describe the prepared image. ImgBB URLs are public, even while the asset is unattached. Upload only images intended for public display. Keep original certificate files out of ImgBB.

Successful uploads insert a `media_assets` record with `attachmentState: 'unattached'`. Future CMS save handlers should validate the asset’s ownership and purpose before attaching it. An abandoned upload or failed CMS save leaves the asset unattached and the existing CMS reference intact. Replacements and removals in the uploader only change the form selection. A provider success followed by a failed metadata insert, or a provider timeout after ImgBB accepts the upload, can leave an untracked image. Handle those cases through private ImgBB account reconciliation until there is an approved cleanup process. Do not automatically delete uploads on retry or replacement. Provider deletion URLs are discarded.

## Provision the owner

Confirm the target database and `OWNER_EMAIL` before running this command. The CLI creates a Better Auth credential account with a verified owner email through a server-only call. The HTTP app leaves email registration disabled and does not load the admin plugin. The command refuses to replace an existing account.

From this folder in PowerShell 7.2 or later, enter a unique password of 12–128 characters from your password manager. The masked input is piped to the process and does not appear in the command line.

```powershell
Read-Host -MaskInput 'Owner password' | npm run --silent owner:provision
```

After provisioning, use Better Auth's `signIn.email` from the frontend client or call its same-origin endpoint `POST /api/auth/sign-in/email`. Then check `GET /api/admin/session` with the resulting cookie.
