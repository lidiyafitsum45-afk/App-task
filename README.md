# Priority — v1

A team task manager sorted into the four Eisenhower quadrants, with live sync across your team and push notifications (assignment, due/overdue, chain hand-offs) that arrive even when the app is closed.

Stack: static PWA frontend + **Supabase** (auth, database, realtime) + **Vercel** (hosting + two small serverless functions for push).

---

## 1. Create the Supabase project

1. Go to supabase.com → New project.
2. Once it's up, open **SQL Editor → New query**, paste in the contents of `supabase-schema.sql`, and run it. This creates the `profiles`, `tasks`, and `notifications_queue` tables, the RLS policies, and the chain-activation trigger.
3. Go to **Authentication → Providers → Email** and make sure "Email OTP / magic link" is enabled (it is by default). Under **Authentication → URL Configuration**, add your Vercel URL (once you have it, step 3) to the redirect allow list.
4. Go to **Project Settings → API**. Copy the **Project URL**, the **anon public key**, and the **service_role key** (keep the service_role key secret — it never goes in the frontend).

## 2. Generate VAPID keys (for push notifications)

Run this once, anywhere with Node installed:

```
npx web-push generate-vapid-keys
```

Save the public and private key it prints out — you'll need both.

## 3. Fill in `config.js`

Open `config.js` and set:

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_ANON_KEY = "your anon key";
const VAPID_PUBLIC_KEY = "the public key from step 2";
```

This file is safe to be public — it only holds the anon key, which is designed to be exposed.

## 4. Deploy to Vercel

```
cd task-app
npm install
npx vercel
```

Follow the prompts to link/create a project. Then set these **environment variables** in the Vercel dashboard (Project → Settings → Environment Variables):

| Name | Value |
|---|---|
| `SUPABASE_URL` | same project URL as above |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (secret) |
| `VAPID_PUBLIC_KEY` | from step 2 |
| `VAPID_PRIVATE_KEY` | from step 2 |
| `SUPABASE_WEBHOOK_SECRET` | make up any long random string |
| `CRON_SECRET` | make up any other long random string |

Redeploy after adding env vars (`npx vercel --prod`).

## 5. Wire up the Supabase → Vercel webhook

This is what makes assignment and chain-handoff notifications fire instantly.

1. In Supabase: **Database → Webhooks → Create a new webhook**.
2. Table: `notifications_queue`. Events: `INSERT`.
3. Type: HTTP request → URL: `https://your-vercel-app.vercel.app/api/send-notification`.
4. Add an HTTP header: `x-webhook-secret: <the SUPABASE_WEBHOOK_SECRET you set in step 4>`.
5. Save.

## 6. Cron for due/overdue reminders

Already configured in `vercel.json` to run every 15 minutes. Vercel automatically sends the `CRON_SECRET` you set as a bearer token to cron routes — no extra setup needed once the env var exists. (Note: Cron Jobs require a Vercel Pro plan or the Hobby plan's included free cron allowance — check your plan's limits.)

## 7. Try it

1. Visit your Vercel URL. Sign in with a work email (you'll get a magic link).
2. Set your name — this creates your team profile.
3. Tap the 🔔 in the top bar and allow notifications.
4. Add a task, assign it to a teammate — they should get a push.
5. Add a second team member the same way (send them the URL); everyone shares the same live dashboard.

---

## What v1 deliberately does NOT include

Per the spec discussion: no sprints, time tracking, subtasks-with-dependencies-graphs, or comments. Chains only support a single linear order (no branching). These were cut to keep v1 shippable — worth reviewing after 2 weeks of real use to see what's actually missing.

## How the core rules work

- **Urgency** is never set by hand — it's computed automatically: due within 48 hours (and not done) = Urgent.
- **Importance** is set once via the calibrating question at creation ("does this hurt a client, revenue, or block someone else if it slips this week?"), and can be changed later by editing the task.
- **Do First cap**: a soft, non-blocking warning appears once you have 5+ active tasks in that quadrant — nudges re-triage instead of forcing it.
- **Chains**: build an ordered list of steps when creating a task. Only the first step is live; the rest sit "queued" and invisible on the dashboard. Finishing the active step automatically activates the next one and notifies its assignee. Queued (not-yet-started) steps can be dragged into a new order at any time from the task's detail view.
