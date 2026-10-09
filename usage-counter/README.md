# Usage counter

A small Cloudflare Worker that counts app installs. Each install sends one random ID a
day. The Worker counts each new ID once and stores no other data.

Deploy (run in this folder, with a Cloudflare account):

```sh
bunx wrangler login
bunx wrangler kv namespace create USERS      # copy the printed id into wrangler.toml
bunx wrangler deploy                          # prints the address, e.g. https://rift-usage-counter.<you>.workers.dev
```

Then set `USAGE_URL` in `src/usage.ts` to that address. Until it is set, the app sends
nothing and shows no count.

Limits: the free plan allows 1,000 KV writes a day, and each new install uses two, so
about 500 new installs a day are counted. Past that, move the storage to D1 or Durable
Objects.
