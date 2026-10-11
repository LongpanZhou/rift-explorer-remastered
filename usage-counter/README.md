# Usage counter

A small Cloudflare Worker that counts app installs. Each install sends one random ID a
day. The Worker counts each new ID once and stores no other data. It runs on Cloudflare's
free plan.

## Put it live (one time, about 5 minutes)

1. **Cloudflare account.** Sign up free at <https://dash.cloudflare.com/sign-up>. Open
   **Workers & Pages** once and pick your `workers.dev` subdomain when asked.
2. **Deploy.** In this folder:

   ```sh
   bunx wrangler login                          # opens the browser to sign in
   bunx wrangler kv namespace create USERS      # copy the printed id into wrangler.toml
   bunx wrangler deploy                         # prints the address
   ```

   The address looks like `https://rift-usage-counter.<you>.workers.dev`. Check it with
   `curl https://rift-usage-counter.<you>.workers.dev/count`, which returns `{"users":0}`.
3. **Connect the app.** Set `COUNTER_URL` in `src/usage.ts` to that address, commit, and push
   a `v*` tag. The new release shows "N users" and a **Count me** switch in the top right corner.

To try it before a release, run
`VITE_USAGE_URL=https://rift-usage-counter.<you>.workers.dev bun run tauri dev`.

## Limits

The free plan allows 1,000 KV writes a day, and each new install uses two, so about 500 new
installs a day are counted. Past that, move the storage to D1 or Durable Objects.
